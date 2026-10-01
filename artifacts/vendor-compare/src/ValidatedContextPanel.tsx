import React from 'react';
import type { ValidatedComparisonContext } from '@workspace/api-client-react';

export const CONTEXT_METADATA_FIELDS = [
  ['Decision Type', 'decisionType'],
  ['Country', 'country'],
  ['State', 'state'],
  ['Customer Location', 'customerLocation'],
  ['Currency', 'currency'],
  ['Product Availability', 'productAvailability'],
  ['Industry', 'industry'],
  ['Organisation Size', 'organisationSize'],
  ['Data Residency', 'dataResidency'],
  ['Market', 'market'],
  ['Market Context', 'marketContext'],
] as const satisfies ReadonlyArray<readonly [string, keyof ValidatedComparisonContext]>;

export function ValidatedContextPanel({ context }: { context?: ValidatedComparisonContext | null }) {
  return <section className="mt-6 rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5 sm:p-6" aria-label="Validated comparison context" data-testid="validated-context">
    <h2 className="display text-xl font-bold tracking-[-.04em] text-[#202840]">Validated comparison context</h2>
    {context ? <>
      <p className="mt-2 text-xs leading-5 text-[#687083]">Checked against the decision brief before research. “Pending research” is not a verified availability claim.</p>
      <dl className="mt-5 grid gap-x-7 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
        {CONTEXT_METADATA_FIELDS.map(([label, key]) => <div key={key} className="min-w-0 border-t border-[#ddd5c5] pt-3">
          <dt className="mono text-[10px] font-bold uppercase tracking-[.12em] text-[#0f766e]">{label}</dt>
          <dd className="mt-1 break-words text-sm font-medium text-[#202840]">{context[key] || 'Not supplied'}</dd>
        </div>)}
      </dl>
    </> : <p className="mt-2 text-xs leading-5 text-[#687083]">Structured validation was not recorded for this older comparison.</p>}
  </section>;
}