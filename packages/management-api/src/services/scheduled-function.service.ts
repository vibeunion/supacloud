import type { SQL } from "bun";
import { sql } from "../db";
import {
  isCanonicalScheduledFunctionTimestamp,
  scheduledFunctionsFromProjectConfig,
  type ScheduledFunctionConfig,
} from "../utils/scheduled-function-config";

export const MAX_SCHEDULES_PER_PROJECT = 20;

export type ScheduledFunctionPatch = Partial<Pick<
  ScheduledFunctionConfig,
  "name" | "cron" | "method" | "body" | "headers" | "enabled"
>>;

interface CreateScheduledFunctionInput {
  ref: string;
  schedule: ScheduledFunctionConfig;
}

interface UpdateScheduledFunctionInput {
  ref: string;
  scheduleId: string;
  expectedUpdatedAt: string;
  patch: ScheduledFunctionPatch;
}

interface DeleteScheduledFunctionInput {
  ref: string;
  scheduleId: string;
  expectedUpdatedAt: string;
}

type CreateScheduledFunctionOutcome =
  | { kind: "created"; schedule: ScheduledFunctionConfig }
  | { kind: "duplicate"; field: "name" | "slug" }
  | { kind: "limit_reached" }
  | { kind: "project_not_found" };

type UpdateScheduledFunctionOutcome =
  | { kind: "updated"; schedule: ScheduledFunctionConfig }
  | { kind: "duplicate"; field: "name" }
  | { kind: "revision_conflict" }
  | { kind: "schedule_not_found" }
  | { kind: "project_not_found" };

type DeleteScheduledFunctionOutcome =
  | { kind: "deleted"; deletedUpdatedAt: string }
  | { kind: "revision_conflict" }
  | { kind: "schedule_not_found" }
  | { kind: "project_not_found" };

type LockedProjectMutation<T> = (projectConfig: unknown, transaction: SQL) => Promise<T>;

async function withLockedProject<T>(ref: string, mutation: LockedProjectMutation<T>): Promise<T | null> {
  return sql.begin(async (transaction) => {
    const [project] = await transaction`
      SELECT config FROM projects
      WHERE ref = ${ref} AND deleted_at IS NULL
      FOR UPDATE
    ` as Array<{ config: unknown }>;
    return project ? mutation(project.config, transaction) : null;
  });
}

async function writeScheduledFunctions(
  transaction: SQL,
  ref: string,
  schedules: ScheduledFunctionConfig[],
): Promise<void> {
  const [updatedProject] = await transaction`
    UPDATE projects
    SET config = jsonb_set(
          COALESCE(config, '{}'::jsonb),
          '{scheduled_functions}',
          ${schedules}::jsonb,
          true
        ),
        updated_at = NOW()
    WHERE ref = ${ref} AND deleted_at IS NULL
    RETURNING ref
  ` as Array<{ ref: string }>;
  if (!updatedProject) throw new Error("Locked Scheduled Function project disappeared before update");
}

function duplicateCreateField(
  schedules: ScheduledFunctionConfig[],
  candidate: ScheduledFunctionConfig,
): "name" | "slug" | null {
  if (schedules.some((schedule) => schedule.name === candidate.name)) return "name";
  return schedules.some((schedule) => schedule.slug === candidate.slug) ? "slug" : null;
}

async function createInLockedProject(
  projectConfig: unknown,
  transaction: SQL,
  input: CreateScheduledFunctionInput,
): Promise<CreateScheduledFunctionOutcome> {
  const schedules = scheduledFunctionsFromProjectConfig(projectConfig);
  if (schedules.length >= MAX_SCHEDULES_PER_PROJECT) return { kind: "limit_reached" };
  const duplicateField = duplicateCreateField(schedules, input.schedule);
  if (duplicateField) return { kind: "duplicate", field: duplicateField };
  await writeScheduledFunctions(transaction, input.ref, [...schedules, input.schedule]);
  return { kind: "created", schedule: input.schedule };
}

function nextUpdatedAt(previousUpdatedAt: string): string {
  const clockTimestamp = new Date().toISOString();
  if (clockTimestamp > previousUpdatedAt) return clockTimestamp;
  const incrementedTimestamp = new Date(Date.parse(previousUpdatedAt) + 1).toISOString();
  if (!isCanonicalScheduledFunctionTimestamp(incrementedTimestamp)) {
    throw new Error("Scheduled Function revision timestamp range exhausted");
  }
  return incrementedTimestamp;
}

function duplicateUpdateName(
  schedules: ScheduledFunctionConfig[],
  scheduleId: string,
  name: string,
): boolean {
  return schedules.some((schedule) => schedule.id !== scheduleId && schedule.name === name);
}

async function updateInLockedProject(
  projectConfig: unknown,
  transaction: SQL,
  input: UpdateScheduledFunctionInput,
): Promise<UpdateScheduledFunctionOutcome> {
  const schedules = scheduledFunctionsFromProjectConfig(projectConfig);
  const target = schedules.find((schedule) => schedule.id === input.scheduleId);
  if (!target) return { kind: "schedule_not_found" };
  if (target.updated_at !== input.expectedUpdatedAt) return { kind: "revision_conflict" };
  const updatedSchedule = { ...target, ...input.patch, updated_at: nextUpdatedAt(target.updated_at) };
  if (duplicateUpdateName(schedules, target.id, updatedSchedule.name)) return { kind: "duplicate", field: "name" };
  const nextSchedules = schedules.map((schedule) => schedule.id === target.id ? updatedSchedule : schedule);
  await writeScheduledFunctions(transaction, input.ref, nextSchedules);
  return { kind: "updated", schedule: updatedSchedule };
}

async function deleteInLockedProject(
  projectConfig: unknown,
  transaction: SQL,
  input: DeleteScheduledFunctionInput,
): Promise<DeleteScheduledFunctionOutcome> {
  const schedules = scheduledFunctionsFromProjectConfig(projectConfig);
  const target = schedules.find((schedule) => schedule.id === input.scheduleId);
  if (!target) return { kind: "schedule_not_found" };
  if (target.updated_at !== input.expectedUpdatedAt) return { kind: "revision_conflict" };
  await writeScheduledFunctions(transaction, input.ref, schedules.filter((schedule) => schedule.id !== target.id));
  return { kind: "deleted", deletedUpdatedAt: target.updated_at };
}

async function createScheduledFunction(
  input: CreateScheduledFunctionInput,
): Promise<CreateScheduledFunctionOutcome> {
  const mutation = await withLockedProject(input.ref, (projectConfig, transaction) =>
    createInLockedProject(projectConfig, transaction, input));
  return mutation ?? { kind: "project_not_found" };
}

async function updateScheduledFunction(
  input: UpdateScheduledFunctionInput,
): Promise<UpdateScheduledFunctionOutcome> {
  const mutation = await withLockedProject(input.ref, (projectConfig, transaction) =>
    updateInLockedProject(projectConfig, transaction, input));
  return mutation ?? { kind: "project_not_found" };
}

async function deleteScheduledFunction(
  input: DeleteScheduledFunctionInput,
): Promise<DeleteScheduledFunctionOutcome> {
  const mutation = await withLockedProject(input.ref, (projectConfig, transaction) =>
    deleteInLockedProject(projectConfig, transaction, input));
  return mutation ?? { kind: "project_not_found" };
}

export const scheduledFunctionService = {
  create: createScheduledFunction,
  update: updateScheduledFunction,
  delete: deleteScheduledFunction,
};
