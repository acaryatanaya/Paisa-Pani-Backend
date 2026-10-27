
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import mysql from "mysql2/promise";
import crypto from "node:crypto";
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
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  let connection: mysql.Connection | undefined;

  try {
    // The API Gateway Cognito authorizer validates the JWT.
    const claims = event.requestContext.authorizer?.jwt?.claims;
    const cognitoSub = claims?.sub;

    if (typeof cognitoSub !== "string" || !cognitoSub) {
      return response(401, {
        status: "error",
        message: "Authentication required.",
      });
    }

    let body: unknown;

    try {
      body = JSON.parse(event.body || "");
    } catch {
      return response(400, {
        status: "error",
        message: "Request body must be valid JSON.",
      });
    }

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !("name" in body) ||
      typeof body.name !== "string"
    ) {
      return response(400, {
        status: "error",
        message: 'Provide a group name, for example: {"name":"Family"}.',
      });
    }

    const name = body.name.trim();

    if (name.length < 1 || name.length > 100) {
      return response(400, {
        status: "error",
        message: "Group name must contain between 1 and 100 characters.",
      });
    }

    const secretArn = process.env.DB_SECRET_ARN;

    if (!secretArn) {
      throw new Error("DB_SECRET_ARN environment variable is missing.");
    }

    const secretResult = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );

    if (!secretResult.SecretString) {
      throw new Error("Database secret has no SecretString.");
    }

    const dbSecret = JSON.parse(
      secretResult.SecretString,
    ) as DatabaseSecret;

    connection = await mysql.createConnection({
      host: dbSecret.host,
      port: dbSecret.port || 3306,
      user: dbSecret.username,
      password: dbSecret.password,
      database: dbSecret.database,
      ssl: { rejectUnauthorized: false },
    });

    // Resolve the internal user ID from the validated Cognito subject.
    const [users] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM users WHERE cognito_sub = ? LIMIT 1`,
      [cognitoSub],
    );

    if (users.length === 0) {
      return response(409, {
        status: "error",
        message: "User profile not found. Call GET /me first.",
      });
    }

    const userId = users[0].id as string;
    const groupId = crypto.randomUUID();

    await connection.beginTransaction();

    try {
      await connection.execute(
        `INSERT INTO \`groups\` (id, name, created_by_user_id)
         VALUES (?, ?, ?)`,
        [groupId, name, userId],
      );

      await connection.execute(
        `INSERT INTO group_members (group_id, user_id, role)
         VALUES (?, ?, 'OWNER')`,
        [groupId, userId],
      );

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }

    return response(201, {
      status: "ok",
      group: {
        id: groupId,
        name,
        role: "OWNER",
        memberCount: 1,
      },
    });
  } catch (error) {
    console.error("Create group failed:", error);

    return response(500, {
      status: "error",
      message: "Unable to create group.",
    });
  } finally {
    if (connection) {
      await connection.end().catch((error) => {
        console.error("Database connection close failed:", error);
      });
    }
  }
};
