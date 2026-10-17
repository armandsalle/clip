import type { Chapter as ChapterSchema, TranscriptSegment as SegmentSchema } from "@clip/contract";

export type Chapter = typeof ChapterSchema.Type;
export type TranscriptSegment = typeof SegmentSchema.Type;
