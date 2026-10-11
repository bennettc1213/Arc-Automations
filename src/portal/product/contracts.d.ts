/** Frontend projections; no browser field grants server authorization. */
export type Mode = 'demo' | 'production';
export interface RecordMeta { id: string; tenantId: string; createdAt: string | null; updatedAt?: string | null }
export interface BusinessSettings { name: string; trade: string; services: string; area: string; timezone: string; days: string; open: string; close: string; alerts: string }
export interface SourceConnection extends RecordMeta { state: 'not_connected' | 'in_progress' | 'pending_review' | 'connected' | 'needs_attention' | 'unavailable'; name: string; detail: string; routingTested?: boolean }
export interface PermissionEvidence { channel: 'sms'; scopes: ('inquiry' | 'reactivation')[]; source?: string; evidence: string; capturedAt: string }
export interface QualificationQuestion { key: 'service' | 'location' | 'urgency' | 'timing'; text: string; required: boolean }
export interface Campaign extends RecordMeta {
  kind: 'missed' | 'inbound' | 'followup'; name: string; source: string; version: number;
  runtime: 'draft' | 'simulated' | 'paused'; channel: 'sms'; audience: 'inquiry' | 'incomplete' | 'reactivation';
  message: string; followup: string; questions: QualificationQuestion[]; cooldown: number; delay: number;
  followupHours: number; maxContacts: number; afterHours: 'next_open' | 'hold'; handoff: string;
  approval: 'review' | 'template'; tone: string; cta: string; offer: string; summary: string;
}
export interface ConversationMessage extends RecordMeta { author: string; body: string; state: 'received' | 'accepted' | 'sent' | 'delivered' | 'failed' | 'unknown' | 'simulated'; at: string }
export interface Lead extends RecordMeta {
  name: string; phone: string | null; source: string; service: string | null; state: string;
  qualification: string; qualificationReason: string; answers: Partial<Record<QualificationQuestion['key'], string>>;
  permission: PermissionEvidence | null; campaignId: string | null; needsOwner?: boolean; unread?: boolean;
  suppressed?: boolean; ownerTakeover?: boolean; booked?: boolean; contactCount?: number;
  lastSentAt?: string; lastActivity: string; followupStopped?: boolean; deliveryFailed?: boolean; messages: ConversationMessage[];
}
export interface EvidenceEvent extends RecordMeta { leadId: string; type: string; at: string; detail?: string; excluded?: boolean }
export interface ReadinessBlocker { code: string; message: string; action: string; checkedAt: string; source: 'server' }
export interface Metric { label: string; value: number | string | null; detail: string; filter: string }
export interface PortalState { schema: 1; mode: Mode; tenantId: string; scenario?: 'new' | 'populated'; asOf: string; business: BusinessSettings; setupStep: number; setupComplete: boolean; evidenceComplete: boolean; campaigns: Campaign[]; connections: SourceConnection[]; leads: Lead[]; events: EvidenceEvent[] }
/** Future server bridge, not an implemented endpoint. Server derives tenant and actor from session. */
export interface CampaignSaveRequest { expectedVersion: number; configuration: Omit<Campaign, keyof RecordMeta | 'runtime'>; idempotencyKey: string }
export interface Acknowledgment { requestId: string; acceptedAt: string; state: 'accepted' | 'rejected'; reason?: string }
