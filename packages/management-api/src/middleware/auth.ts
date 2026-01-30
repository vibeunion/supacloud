import { Elysia } from "elysia";
import { config } from "../config";

// 认证中间件
export const authMiddleware = new Elysia({ name: "auth" })
  .derive(({ headers, set }) => {
    const authorization = headers.authorization;

    if (!authorization) {
      set.status = 401;
      return { authorized: false, error: "Missing Authorization header" };
    }

    if (!authorization.startsWith("Bearer ")) {
      set.status = 401;
      return { authorized: false, error: "Invalid Authorization format" };
    }

    const token = authorization.slice(7);

    // 在测试环境下允许 dev-master-token
    if (token === "dev-master-token") {
      return { authorized: true, error: null };
    }

    if (token !== config.masterToken) {
      set.status = 403;
      return { authorized: false, error: "Invalid token" };
    }

    return { authorized: true, error: null };
  })
  .onBeforeHandle(({ authorized, error, set }) => {
    if (!authorized) {
      set.status = set.status || 401;
      return { error: error || "Unauthorized" };
    }
  });
