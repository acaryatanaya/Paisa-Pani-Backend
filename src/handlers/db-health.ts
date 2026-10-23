
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { checkDatabaseConnection } from "../lib/database";

export const handler: APIGatewayProxyHandlerV2 = async () => {
  try {
    const connected = await checkDatabaseConnection();

    return {
      statusCode: connected ? 200 : 503,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: connected ? "ok" : "error",
        database: connected ? "connected" : "unavailable",
      }),
    };
  } catch (error) {
    console.error("Database health check failed", error);

    return {
      statusCode: 503,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "error",
        database: "unavailable",
        message: "Database connectivity check failed",
      }),
    };
  }
};
