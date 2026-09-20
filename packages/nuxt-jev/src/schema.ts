import type { SQLiteColumnBuilder } from 'drizzle-orm/sqlite-core'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/** Extra columns apps merge into `jev_decisions`, as drizzle column builders. */
export type JevDecisionsExtraColumns = Record<string, SQLiteColumnBuilder>

// One durable typed judgement from the Jev model, keyed for reuse: the same
// seat, subject digest, and question version is asked at most once. Reuse
// reads the row instead of re-asking; `stateSnapshot` keeps the exact input so
// a new question version can replay history (jev evals). Rows carry no
// user/team FKs by design: `siteId`/`subjectRef` are join keys the consuming
// layer owns. Apps merge the returned table into their own schema.
export function createJevDecisionsTable(extraColumns: JevDecisionsExtraColumns = {}) {
  return sqliteTable('jev_decisions', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    seat: text('seat').notNull(),
    subjectDigest: text('subject_digest').notNull(),
    questionVersion: text('question_version').notNull(),
    stateDigest: text('state_digest').notNull(),
    stateSnapshot: text('state_snapshot', { mode: 'json' }).$type<unknown>().notNull(),
    answers: text('answers', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    provenance: text('provenance', { enum: ['model', 'reuse'] }).notNull(),
    model: text('model').notNull(),
    siteId: text('site_id'),
    subjectRef: text('subject_ref'),
    latencyMs: integer('latency_ms'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
    ...extraColumns,
  }, t => [
    uniqueIndex('jev_decisions_seat_subject_version_unique').on(t.seat, t.subjectDigest, t.questionVersion),
    index('jev_decisions_site_seat_idx').on(t.siteId, t.seat),
    index('jev_decisions_subject_ref_idx').on(t.subjectRef),
  ])
}

export type JevDecisionsTable = ReturnType<typeof createJevDecisionsTable>
export type JevDecisionRow = JevDecisionsTable['$inferSelect']
export type JevDecisionInsert = JevDecisionsTable['$inferInsert']
