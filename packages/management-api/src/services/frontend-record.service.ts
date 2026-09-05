/**
 * Frontend Deployment Records Service
 * Handles: deployment history, build records, audit trail
 * 
 * Extracted from frontend.service.ts to reduce file size.
 */
import { $ } from "bun";
import { logger } from "../utils/logger";
import { maskFrontendBuildLog } from "../utils/frontend-security";
import type { DeploymentRecord } from "../types/frontend";

export class FrontendRecordService {
  constructor(private baseDir: string) {}

  private joinPath(...parts: string[]): string {
    return parts.join("/").replace(/\/+/g, "/");
  }

  async createDeploymentRecord(
    projectRef: string,
    deploymentId: string,
    record: Partial<DeploymentRecord>
  ): Promise<string> {
    const recordId = crypto.randomUUID().substring(0, 8);
    const recordPath = this.joinPath(
      this.baseDir,
      projectRef,
      deploymentId,
      "records",
      `${recordId}.json`
    );

    await $`mkdir -p ${this.joinPath(this.baseDir, projectRef, deploymentId, "records")}`.quiet();

    const fullRecord = {
      id: recordId,
      deployment_id: deploymentId,
      project_ref: projectRef,
      status: record.status || "pending",
      commit_sha: record.commit_sha,
      commit_message: record.commit_message,
      branch: record.branch,
      triggered_by: record.triggered_by || "manual",
      build_log: maskFrontendBuildLog(record.build_log),
      started_at: new Date().toISOString(),
    };

    await Bun.write(recordPath, JSON.stringify(fullRecord, null, 2));

    return recordId;
  }

  async updateDeploymentRecord(
    projectRef: string,
    deploymentId: string,
    recordId: string,
    updates: Partial<DeploymentRecord>
  ): Promise<void> {
    const recordPath = this.joinPath(
      this.baseDir,
      projectRef,
      deploymentId,
      "records",
      `${recordId}.json`
    );

    try {
      const record = await Bun.file(recordPath).json();
      const updated = {
        ...record,
        ...updates,
        ...(updates.build_log !== undefined
          ? { build_log: maskFrontendBuildLog(updates.build_log) }
          : {}),
        finished_at: updates.status === "success" || updates.status === "failed" 
          ? new Date().toISOString() 
          : undefined,
        duration: updates.status === "success" || updates.status === "failed"
          ? Date.now() - new Date(record.started_at).getTime()
          : undefined,
      };

      await Bun.write(recordPath, JSON.stringify(updated, null, 2));
    } catch (e: unknown) { logger.debug("[services/frontend-record] suppressed error", { error: e instanceof Error ? e.message : String(e) }); }
  }

  async listDeploymentRecords(
    projectRef: string,
    deploymentId: string
  ): Promise<DeploymentRecord[]> {
    const recordsDir = this.joinPath(this.baseDir, projectRef, deploymentId, "records");
    const records: DeploymentRecord[] = [];

    try {
      const result = await $`ls ${recordsDir}`.quiet();
      const files = result.text().trim().split("\n").filter(Boolean);

      for (const file of files) {
        try {
          const record = await Bun.file(this.joinPath(recordsDir, file)).json();
          records.push(record);
        } catch (err: unknown) {
          logger.warn("[FrontendRecordService] Failed to read deployment record", { error: err });
          continue;
        }
      }

      return records.sort((a, b) => 
        new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
      );
    } catch (err: unknown) {
      logger.warn("[FrontendRecordService] Failed to list record files", { error: err });
      return [];
    }
  }

  async getDeploymentRecord(
    projectRef: string,
    deploymentId: string,
    recordId: string
  ): Promise<DeploymentRecord | null> {
    const recordPath = this.joinPath(
      this.baseDir,
      projectRef,
      deploymentId,
      "records",
      `${recordId}.json`
    );

    try {
      return await Bun.file(recordPath).json();
    } catch (err: unknown) {
      logger.warn("[FrontendRecordService] Failed to read deployment record file", { error: err });
      return null;
    }
  }
}
