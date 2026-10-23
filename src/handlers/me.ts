
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import mysql from "mysql2/promise";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  CognitoIdentityProviderClient,
  GetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const region = process.env.AWS_REGION || "ap-south-1";

const secretsClient = new SecretsManagerClient({ region });
const cognitoClient = new CognitoIdentityProviderClient({ region });

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
  // API Gateway validates the JWT before invoking this handler.
  // Use its verified subject as the authenticated user's identity.
  const claims = event.requestContext.authorizer?.jwt?.claims;
  const cognitoSub = claims?.sub;

  if (typeof cognitoSub !== "string" || !cognitoSub) {
    return {
      statusCode: 401,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "error",
        message: "Authenticated user identity is missing",
      }),
    };
  }

  // Cognito access tokens may not contain email or name.
  // Retrieve those attributes using the authenticated access token.
  const authorization =
    event.headers.authorization ?? event.headers.Authorization;

  const tokenMatch = authorization?.match(/^Bearer\s+(\S+)$/i);
  const accessToken = tokenMatch?.[1];

  if (!accessToken) {
    return {
      statusCode: 401,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "error",
        message: "Bearer access token is missing",
      }),
    };
  }

  let connection: mysql.Connection | undefined;

  try {
    const cognitoUser = await cognitoClient.send(
      new GetUserCommand({ AccessToken: accessToken })
    );

    const attributes = Object.fromEntries(
      (cognitoUser.UserAttributes ?? []).map((attribute) => [
        attribute.Name,
        attribute.Value,
      ])
    );

    const email = attributes.email;
    const name =
      attributes.name ??
      (
      [attributes.given_name, attributes.family_name]
        .filter(Boolean)
        .join(" ") ||
      email?.split("@")[0]
      );

    if (!email || !name) {
      return {
        statusCode: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "error",
          message: "Email or name is missing from the Cognito profile",
        }),
      };
    }

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

      // Temporary demo setting. Restore TLS certificate verification
      // with the correct RDS CA bundle before production use.
      ssl: { rejectUnauthorized: false },
    });

    // Find the internal database user by the verified Cognito subject.
    const [existingRows] = await connection.execute(
      `SELECT id, cognito_sub, name, email, created_at
       FROM users
       WHERE cognito_sub = ?
       LIMIT 1`,
      [cognitoSub]
    );

    let profile = (existingRows as UserProfile[])[0];

    if (!profile) {
      // Do not automatically link an existing account by email alone.
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
