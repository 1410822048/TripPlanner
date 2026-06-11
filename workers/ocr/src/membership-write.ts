// workers/ocr/src/membership-write.ts
// Barrel for the membership domain, split 2026-06-11 into three focused
// modules — implementation moved, public surface unchanged:
//   invite-write.ts            — /invite-redeem, /invite-create, /invite-revoke
//   member-lifecycle-write.ts  — /member-remove, /member-leave,
//                                /member-role-update, /owner-transfer
//   membership-shared.ts       — MembershipValidationError + authz/strip helpers
// index.ts + the spec import from here, so the public API has one entry point
// and the swap is provably behaviour-preserving.
export {
  inviteRedeem,
  inviteCreate,
  inviteRevoke,
  InviteRedeemRequestSchema,
  InviteCreateRequestSchema,
  InviteRevokeRequestSchema,
  type InviteRedeemRequest,
  type InviteCreateRequest,
  type InviteRevokeRequest,
  type InviteRedeemOutcome,
  type InviteCreateResult,
} from './invite-write'
export {
  memberRemove,
  memberLeave,
  memberRoleUpdate,
  ownerTransfer,
  MemberRemoveRequestSchema,
  MemberLeaveRequestSchema,
  MemberRoleUpdateRequestSchema,
  OwnerTransferRequestSchema,
  type MemberRemoveRequest,
  type MemberLeaveRequest,
  type MemberRoleUpdateRequest,
  type OwnerTransferRequest,
} from './member-lifecycle-write'
export { MembershipValidationError, type TxReadDoc } from './membership-shared'
