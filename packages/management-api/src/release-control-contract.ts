// 标准应用级发布契约已在共享 delivery 包中定义，管理 API 保留原导入路径以兼容既有调用方。
export {
  RELEASE_CONTRACT_SCHEMA as RELEASE_CONTROL_CONTRACT_VERSION,
  assertReleaseReceiptTransition,
  parseReleaseReceipt,
  parseReleaseScope,
  releaseScopeSha256,
} from "@supacloud/delivery/release-contract";
export type {
  ReleaseComponent,
  ReleaseReceipt,
  ReleaseReceiptPhase,
  ReleaseScope,
} from "@supacloud/delivery/release-contract";
