
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import mysql from "mysql2/promise";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const secretsClient = new SecretsManagerClient({
  region: process.env.AWS_REGION || "ap-south-1",
});

interface DatabaseSecret {
  username: string;
  password: string;
  host: string;
  port: number;
  database: string;
}

interface Category {
  id: number;
  name: string;
  emoji: string | null;
}

export const handler: APIGatewayProxyHandlerV2 = async () => {
  let connection: mysql.Connection | undefined;

  try {
    const secretArn = process.env.DB_SECRET_ARN;

    if (!secretArn) {
      throw new Error("DB_SECRET_ARN is not configured");
    }

    const result = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: secretArn })
    );

    if (!result.SecretString) {
      throw new Error("Database secret has no SecretString");
    }

    const secret = JSON.parse(result.SecretString) as DatabaseSecret;

    connection = await mysql.createConnection({
      host: secret.host,
      port: Number(secret.port || 3306),
      user: secret.username,
      password: secret.password,
      database: secret.database,
      connectTimeout: 5000,
      // Temporary demo setting; restore certificate verification
      // with the correct RDS CA bundle before production use.
      ssl: { rejectUnauthorized: false },
    });

    const [rows] = await connection.execute(
      `SELECT id, name, emoji
       FROM categories
       WHERE is_active = 1
       ORDER BY name ASC`
    );

    const categories = rows as Category[];

    return {
      statusCode: 200,
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        status: "ok",
        count: categories.length,
        categories,
      }),
    };
  } catch (error) {
    console.error("Failed to fetch categories", error);

    return {
      statusCode: 500,
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        status: "error",
        message: "Unable to fetch categories",
      }),
    };
  } finally {
    if (connection) {
      await connection.end().catch((error) => {
        console.error("Failed to close database connection", error);
      });
    }
  }
};
