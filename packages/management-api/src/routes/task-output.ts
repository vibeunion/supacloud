import { createTaskOutputRoutes } from "./task-output-route-factory";
import * as auth from "../middleware/auth";
import { taskOutputService } from "../services/task-output.service";
import { taskOutputResponse } from "./task-output-handler";

export const taskOutputRoutes = createTaskOutputRoutes({
  async authorizeRead(request, projectRef) {
    const invokerUserId = await auth.getTaskOutputInvoker(request, projectRef);
    if (invokerUserId) return { invokerUserId };
    const rejected = await auth.requireProjectOrAdminAuth(request, projectRef);
    return rejected ? taskOutputResponse(rejected.body, rejected.status) : { invokerUserId: null };
  },
  async authorizeWrite(request, projectRef) {
    const rejected = await auth.requireProjectOrAdminAuth(request, projectRef);
    return rejected ? taskOutputResponse(rejected.body, rejected.status) : null;
  },
  read: taskOutputService.read,
  append: taskOutputService.append,
});
