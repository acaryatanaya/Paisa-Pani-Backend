
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import mysql from "mysql2/promise";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const region = process.env.AWS_REGION || "ap-south-1";

const secretsClient = new SecretsManagerClient({ region });

interface DatabaseSecret {
  username: string;
  password: string;
  host: string;
  port?: number;
  database: string;
}

function response(statusCode: number, body: object) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  let connection: mysql.Connection | undefined;

  try {
    // Get the authenticated Cognito user from API Gateway JWT claims.
    const claims = event.requestContext.authorizer?.jwt?.claims;
    const cognitoSub = claims?.sub;

    if (typeof cognitoSub !== "string" || !cognitoSub) {
      return response(401, {
        status: "error",
        message: "Authentication required.",
      });
    }

    // Read the database secret ARN from the Lambda environment.
    const secretArn = process.env.DB_SECRET_ARN;

    if (!secretArn) {
      throw new Error("DB_SECRET_ARN environment variable is missing.");
    }

    // Retrieve database credentials from AWS Secrets Manager.
    const secretResult = await secretsClient.send(
      new GetSecretValueCommand({
        SecretId: secretArn,
      }),
    );

    if (!secretResult.SecretString) {
      throw new Error("Database secret has no SecretString.");
    }

    const dbSecret = JSON.parse(
      secretResult.SecretString,
    ) as DatabaseSecret;

    // Connect to the existing RDS MySQL database.
    connection = await mysql.createConnection({
      host: dbSecret.host,
      port: dbSecret.port || 3306,
      user: dbSecret.username,
      password: dbSecret.password,
      database: dbSecret.database,
      ssl: {
        rejectUnauthorized: false,
      },
    });

    // Map the Cognito subject to the internal users.id.
    const [users] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT id
       FROM users
       WHERE cognito_sub = ?
       LIMIT 1`,
      [cognitoSub],
    );

    if (users.length === 0) {
      return response(409, {
        status: "error",
        message: "User profile not found. Call GET /me first.",
      });
    }

    const userId = users[0].id as string;

    // Return only groups in which this user is a member.
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT
         g.id,
         g.name,
         g.created_at AS createdAt,
         gm.role,
         (
           SELECT COUNT(*)
           FROM group_members AS member_count
           WHERE member_count.group_id = g.id
         ) AS memberCount
       FROM \`groups\` AS g
       INNER JOIN group_members AS gm
         ON gm.group_id = g.id
       WHERE gm.user_id = ?
       ORDER BY g.created_at DESC, g.id DESC`,
      [userId],
    );

    return response(200, {
      status: "ok",
      groups: rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.createdAt,
        role: row.role,
        memberCount: Number(row.memberCount),
      })),
    });
  } catch (error) {
    console.error("List groups failed:", error);

    return response(500, {
      status: "error",
      message: "Unable to list groups.",
    });
  } finally {
    if (connection) {
      await connection.end().catch((error) => {
        console.error("Database connection close failed:", error);
      });
    }
  }
};
