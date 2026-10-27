
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import mysql from "mysql2/promise";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  CognitoIdentityProviderClient,
  GetUserCommand,
  UpdateUserAttributesCommand,
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

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const claims = event.requestContext.authorizer?.jwt?.claims;
  const cognitoSub = claims?.sub;

  if (typeof cognitoSub !== "string" || !cognitoSub) {
    return jsonResponse(401, {
      status: "error",
      message: "Authenticated user identity is missing",
    });
  }

  const authorization =
    event.headers.authorization ?? event.headers.Authorization;
  const tokenMatch = authorization?.match(/^Bearer\s+(\S+)$/i);
  const accessToken = tokenMatch?.[1];

  if (!accessToken) {
    return jsonResponse(401, {
      status: "error",
      message: "Bearer access token is missing",
    });
  }

  let body: unknown;

  try {
    body = JSON.parse(event.body ?? "");
  } catch {
    return jsonResponse(400, {
      status: "error",
      message: "Request body must be valid JSON",
    });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(400, {
      status: "error",
      message: "Request body must be a JSON object",
    });
  }

  const payload = body as Record<string, unknown>;
  const keys = Object.keys(payload);

  if (keys.length !== 1 || keys[0] !== "name") {
    return jsonResponse(400, {
      status: "error",
      message: "Only the name field can be updated",
    });
  }

  if (typeof payload.name !== "string") {
    return jsonResponse(400, {
      status: "error",
      message: "Name must be a string",
    });
  }

  const name = payload.name.trim();

  if (name.length < 1 || name.length > 100) {
    return jsonResponse(400, {
      status: "error",
      message: "Name must contain between 1 and 100 characters",
    });
  }

  let connection: mysql.Connection | undefined;
  let cognitoUpdated = false;

  try {
    // Confirm the access token is valid and belongs to the expected user.
    const cognitoUser = await cognitoClient.send(
      new GetUserCommand({ AccessToken: accessToken })
    );

    const attributes = Object.fromEntries(
      (cognitoUser.UserAttributes ?? []).map((attribute) => [
        attribute.Name,
        attribute.Value,
      ])
    );

    if (attributes.sub !== cognitoSub) {
      return jsonResponse(401, {
        status: "error",
        message: "Token identity mismatch",
      });
    }

    if (!attributes.email) {
      return jsonResponse(400, {
        status: "error",
        message: "Email is missing from the Cognito profile",
      });
    }

    // Update Cognito using the authenticated user's own access token.
    await cognitoClient.send(
      new UpdateUserAttributesCommand({
        AccessToken: accessToken,
        UserAttributes: [{ Name: "name", Value: name }],
      })
    );
    cognitoUpdated = true;

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
      // Matches the current setup. Configure verified RDS TLS before production.
      ssl: { rejectUnauthorized: false },
    });

    const [result] = await connection.execute<mysql.ResultSetHeader>(
      `UPDATE users
       SET name = ?
       WHERE cognito_sub = ?`,
      [name, cognitoSub]
    );

    if (result.affectedRows === 0) {
      // The profile may be unchanged, or the DB profile may not exist.
      const [rows] = await connection.execute<mysql.RowDataPacket[]>(
        "SELECT id FROM users WHERE cognito_sub = ? LIMIT 1",
        [cognitoSub]
      );

      if (rows.length === 0) {
        return jsonResponse(409, {
          status: "error",
          message:
            "Cognito was updated, but the database profile is missing. Call GET /me to initialize the profile, then retry.",
        });
      }
    }

    return jsonResponse(200, {
      status: "ok",
      user: {
        name,
        email: attributes.email,
      },
    });
  } catch (error) {
    console.error("Failed to update profile", {
      cognitoUpdated,
      error,
    });

    return jsonResponse(500, {
      status: "error",
      message: cognitoUpdated
        ? "Cognito profile was updated, but database synchronization failed. Retry the update."
        : "Unable to update profile",
    });
  } finally {
    if (connection) {
      await connection.end().catch((error) => {
        console.error("Failed to close database connection", error);
      });
    }
  }
};
