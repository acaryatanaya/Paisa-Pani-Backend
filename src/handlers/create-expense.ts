
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import mysql from "mysql2/promise";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { randomUUID } from "node:crypto";

const region = process.env.AWS_REGION || "ap-south-1";
const secretsClient = new SecretsManagerClient({ region });

interface DatabaseSecret {
  username: string;
  password: string;
  host: string;
  port?: number;
  database: string;
}

interface CreateExpenseInput {
  amount: number;
  categoryId: number;
  comment?: string;
  expenseDate: string;
  expenseTime: string;
  scope: "PERSONAL";
  emoji?: string;
}

const jsonResponse = (
  statusCode: number,
  body: Record<string, unknown>
) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function isValidTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value);
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  // API Gateway validates the Cognito JWT before invoking this function.
  const claims = event.requestContext.authorizer?.jwt?.claims;
  const cognitoSub = claims?.sub;

  if (typeof cognitoSub !== "string" || !cognitoSub) {
    return jsonResponse(401, {
      status: "error",
      message: "Authenticated user identity is missing",
    });
  }

  let input: CreateExpenseInput;

  try {
    if (!event.body) {
      return jsonResponse(400, {
        status: "error",
        message: "Request body is required",
      });
    }

    input = JSON.parse(event.body) as CreateExpenseInput;
  } catch {
    return jsonResponse(400, {
      status: "error",
      message: "Request body must be valid JSON",
    });
  }

  const {
    amount,
    categoryId,
    comment,
    expenseDate,
    expenseTime,
    scope,
    emoji,
  } = input;

if (
  typeof amount !== "number" ||
  !Number.isFinite(amount) ||
  amount <= 0 ||
  amount > 9999999999.99 ||
  !/^\d{1,10}(?:\.\d{1,2})?$/.test(String(amount))
) {
  return jsonResponse(400, {
    status: "error",
    message:
      "Amount must be positive and have at most two decimal places",
  });
}

  if (
    typeof categoryId !== "number" ||
    !Number.isSafeInteger(categoryId) ||
    categoryId <= 0
  ) {
    return jsonResponse(400, {
      status: "error",
      message: "categoryId must be a positive integer",
    });
  }

  if (scope !== "PERSONAL") {
    return jsonResponse(400, {
      status: "error",
      message: "Only PERSONAL expenses are supported currently",
    });
  }

  if (typeof expenseDate !== "string" || !isValidDate(expenseDate)) {
    return jsonResponse(400, {
      status: "error",
      message: "expenseDate must be a valid date in YYYY-MM-DD format",
    });
  }

  if (typeof expenseTime !== "string" || !isValidTime(expenseTime)) {
    return jsonResponse(400, {
      status: "error",
      message: "expenseTime must be in HH:mm:ss format",
    });
  }

  if (
    comment !== undefined &&
    (typeof comment !== "string" || comment.length > 500)
  ) {
    return jsonResponse(400, {
      status: "error",
      message: "comment must be a string of at most 500 characters",
    });
  }

  if (
    emoji !== undefined &&
    (typeof emoji !== "string" || [...emoji].length > 16)
  ) {
    return jsonResponse(400, {
      status: "error",
      message: "emoji must be a string of at most 16 characters",
    });
  }

  const secretArn = process.env.DB_SECRET_ARN;
  if (!secretArn) {
    console.error("DB_SECRET_ARN is not configured");
    return jsonResponse(500, {
      status: "error",
      message: "Server configuration error",
    });
  }

  let connection: mysql.Connection | undefined;

  try {
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

      // Temporary demo setting. Enable certificate verification before production.
      ssl: { rejectUnauthorized: false },
    });

    // Resolve the internal user ID from the verified Cognito identity.
    const [userRows] = await connection.execute(
      `SELECT id FROM users WHERE cognito_sub = ? LIMIT 1`,
      [cognitoSub]
    );

    const user = (userRows as { id: string }[])[0];

    if (!user) {
      return jsonResponse(404, {
        status: "error",
        message: "User profile not found. Call GET /me first.",
      });
    }

    // Ensure the category exists and is active.
    const [categoryRows] = await connection.execute(
      `SELECT id FROM categories WHERE id = ? AND is_active = 1 LIMIT 1`,
      [categoryId]
    );

    if ((categoryRows as { id: number }[]).length === 0) {
      return jsonResponse(400, {
        status: "error",
        message: "Category does not exist or is inactive",
      });
    }

    const expenseId = randomUUID();

    await connection.execute(
      `INSERT INTO expenses (
        id,
        created_by_user_id,
        paid_by_user_id,
        category_id,
        amount,
        \`comment\`,
        expense_date,
        expense_time,
        scope,
        group_id,
        emoji
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PERSONAL', NULL, ?)`,
      [
        expenseId,
        user.id,
        user.id,
        categoryId,
        amount.toFixed(2),
        comment ?? null,
        expenseDate,
        expenseTime,
        emoji ?? null,
      ]
    );

    return jsonResponse(201, {
      status: "ok",
      expense: {
        id: expenseId,
        amount: amount.toFixed(2),
        categoryId,
        comment: comment ?? null,
        expenseDate,
        expenseTime,
        scope: "PERSONAL",
        groupId: null,
        emoji: emoji ?? null,
      },
    });
  } catch (error) {
    console.error("Failed to create expense", error);

    return jsonResponse(500, {
      status: "error",
      message: "Unable to create expense",
    });
  } finally {
    if (connection) {
      await connection.end().catch((error) => {
        console.error("Failed to close database connection", error);
      });
    }
  }
};
