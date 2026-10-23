
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

export async function checkDatabaseConnection(): Promise<boolean> {
  const secretArn = process.env.DB_SECRET_ARN;

  if (!secretArn) {
    throw new Error("DB_SECRET_ARN is not configured");
  }

  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );

  if (!response.SecretString) {
    throw new Error("Database secret has no SecretString");
  }

  const secret = JSON.parse(response.SecretString) as DatabaseSecret;

  const connection = await mysql.createConnection({
    host: secret.host,
    port: Number(secret.port || 3306),
    user: secret.username,
    password: secret.password,
    database: secret.database,
    connectTimeout: 5000,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const [rows] = await connection.query("SELECT 1 AS db_ok");
    return Array.isArray(rows) && rows.length > 0;
  } finally {
    await connection.end();
  }
}
