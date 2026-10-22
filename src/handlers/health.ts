
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";

export const handler: APIGatewayProxyHandlerV2 = async () => {
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      status: "ok",
      service: "paisa-pani-backend",
      timestamp: new Date().toISOString(),
    }),
  };
};
