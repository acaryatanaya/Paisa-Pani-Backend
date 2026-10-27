
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import mysql from "mysql2/promise";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const secretsClient = new SecretsManagerClient({});
const secretArn = process.env.DB_SECRET_ARN!;

type DbSecret = {
  host: string;
  username: string;
  password: string;
  dbname?: string;
  database?: string;
  port?: number;
};

async function getDbConnection() {
  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );

  if (!result.SecretString) {
    throw new Error("Database secret has no SecretString");
  }

  const secret = JSON.parse(result.SecretString) as DbSecret;

  return mysql.createConnection({
    host: secret.host,
    user: secret.username,
    password: secret.password,
    database: secret.dbname ?? secret.database ?? "paisa_pani",
    port: secret.port ?? 3306,
    ssl: { rejectUnauthorized: false },
    connectTimeout: 10000,
  });
}

function response(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub;

  if (typeof sub !== "string" || !sub) {
    return response(401, { message: "Unauthorized" });
  }

  let connection: mysql.Connection | undefined;

  try {
    connection = await getDbConnection();

    const [users] = await connection.execute<mysql.RowDataPacket[]>(
      "SELECT id FROM users WHERE cognito_sub = ? LIMIT 1",
      [sub]
    );

    if (users.length === 0) {
      return response(200, { expenses: [] });
    }

    const userId = users[0].id;

    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT
         e.id,
         e.amount,
         e.category_id AS categoryId,
         c.name AS category,
         e.comment,
         DATE_FORMAT(e.expense_date, '%Y-%m-%d') AS expenseDate,
         TIME_FORMAT(e.expense_time, '%H:%i:%s') AS expenseTime,
         e.scope,
         e.group_id AS groupId,
         e.emoji,
         e.created_at AS createdAt
       FROM expenses e
       INNER JOIN categories c ON c.id = e.category_id
       WHERE e.created_by_user_id = ?
         AND e.scope = 'PERSONAL'
       ORDER BY e.expense_date DESC, e.expense_time DESC, e.created_at DESC`,
      [userId]
    );

    return response(200, {
      expenses: rows.map((row) => ({
        id: row.id,
        amount: Number(row.amount),
        categoryId: Number(row.categoryId),
        category: row.category,
        comment: row.comment,
        expenseDate: row.expenseDate,
        expenseTime: row.expenseTime,
        scope: row.scope,
        groupId: row.groupId,
        emoji: row.emoji,
        createdAt: row.createdAt,
      })),
    });
  } catch (error) {
    console.error("Failed to list expenses", error);
    return response(500, { message: "Failed to retrieve expenses" });
  } finally {
    if (connection) {
      await connection.end().catch((error) => {
        console.error("Failed to close database connection", error);
      });
    }
  }
};
