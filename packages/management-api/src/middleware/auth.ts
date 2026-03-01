import { Elysia } from "elysia";
import { config } from "../config";

// 认证中间件
export const authMiddleware = (app: Elysia) =>
  app.derive(({ headers, set }) => {
    const authorization = headers.authorization;

    if (!authorization) {
      set.status = 401;
      return { authorized: false, authError: "Missing Authorization header" };
    }

    if (!authorization.startsWith("Bearer ")) {
      set.status = 401;
      return { authorized: false, authError: "Invalid Authorization format" };
    }

    const token = authorization.slice(7);

    if (token !== config.masterToken) {
      set.status = 403;
      return { authorized: false, authError: "Invalid token" };
    }

    return { authorized: true, authError: null };
  })
    .onBeforeHandle(({ authorized, authError, set }) => {
      if (authorized === false) {
        set.status = set.status || 401;
        return { error: authError || "Unauthorized" };
      }
    });
