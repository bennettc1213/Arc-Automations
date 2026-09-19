/**
 * The public ingest boundary's validator.
 *
 * The implementation moved to `../_shared/event-validation.ts` with Lead Recovery (0010),
 * because Arc now emits events as well as receiving them and there must be exactly one set
 * of rules for both. This file stays because the boundary has a documented name: the event
 * contract, the deploy instructions and two years of comments all point at
 * `functions/ingest/validate.ts` as the place a payload is judged, and moving the door
 * without leaving the sign up would make every one of those references wrong.
 *
 * Nothing is added or removed here. If these two files ever disagree, this one is the
 * mistake.
 */

export {
  ACTORS,
  ENTITY_TYPES,
  ERROR_CLASSES,
  EVENT_TYPES,
  MAX_BATCH,
  SOURCE_SYSTEMS,
  validateBody,
  validateEvent,
} from '../_shared/event-validation.ts';

export type {
  EventType,
  IncomingEvent,
  ValidationResult,
} from '../_shared/event-validation.ts';
