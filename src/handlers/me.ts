
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
  port?: number;
  database: string;
}

interface UserProfile {
  id: string;
  cognito_sub: string;
  name: string;
  email: string;
  created_at: Date;
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  // These claims are supplied by API Gateway after JWT validation.
  const claims = event.requestContext.authorizer?.jwt?.claims;

  const cognitoSub = claims?.sub;
  const email = claims?.email;
  const name = claims?.name ?? claims?.["cognito:username"];

  if (
    typeof cognitoSub !== "string" ||
    typeof email !== "string" ||
    typeof name !== "string" ||
    !cognitoSub ||
    !email ||
    !name
  ) {
    return {
      statusCode: 400,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "error",
        message: "Required Cognito profile claims are missing",
      }),
    };
  }

  let connection: mysql.Connection | undefined;

  try {
    const secretArn = process.env.DB_SECRET_ARN;

    if (!secretArn) {
      throw new Error("DB_SECRET_ARN is not configured");
    }

    const secretResult = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: secretArn })
    );

    if (!secretResult.SecretString) {
      throw new Error("Database secret has no SecretString");
    }

    const secret = JSON.parse(
      secretResult.SecretString
    ) as DatabaseSecret;

    connection = await mysql.createConnection({
      host: secret.host,
      port: Number(secret.port || 3306),
      user: secret.username,
      password: secret.password,
      database: secret.database,
      connectTimeout: 5000,

      // Temporary demo setting. Restore certificate verification
      // using the correct RDS CA bundle before production use.
      ssl: { rejectUnauthorized: false },
    });

    // Look up the user by the verified Cognito subject.
    const [existingRows] = await connection.execute(
      `SELECT id, cognito_sub, name, email, created_at
       FROM users
       WHERE cognito_sub = ?
       LIMIT 1`,
      [cognitoSub]
    );

    let profile = (existingRows as UserProfile[])[0];

    if (!profile) {
      // Avoid silently linking an existing account based only on email.
      const [emailRows] = await connection.execute(
        `SELECT id, cognito_sub
         FROM users
         WHERE email = ?
         LIMIT 1`,
        [email]
      );

      const existingEmailUser = (
        emailRows as Pick<UserProfile, "id" | "cognito_sub">[]
      )[0];

      if (existingEmailUser) {
        return {
          statusCode: 409,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            status: "error",
            message:
              "An account with this email already exists. Account linking is required.",
          }),
        };
      }

      // Create a new internal user ID and link it to Cognito.
      const userId = crypto.randomUUID();

      await connection.execute(
        `INSERT INTO users (id, cognito_sub, name, email)
         VALUES (?, ?, ?, ?)`,
        [userId, cognitoSub, name, email]
      );

      const [newRows] = await connection.execute(
        `SELECT id, cognito_sub, name, email, created_at
         FROM users
         WHERE cognito_sub = ?
         LIMIT 1`,
        [cognitoSub]
      );

      profile = (newRows as UserProfile[])[0];

      if (!profile) {
        throw new Error("User profile was not available after creation");
      }
    }

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "ok",
        user: {
          id: profile.id,
          name: profile.name,
          email: profile.email,
          createdAt: profile.created_at,
        },
      }),
    };
  } catch (error) {
    console.error("Failed to get user profile", error);

    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "error",
        message: "Unable to retrieve user profile",
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
