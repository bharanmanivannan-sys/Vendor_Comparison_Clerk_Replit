import React from 'react';
import { UNRESOLVED_DISCOVERY_EXPLANATION, UNRESOLVED_DISCOVERY_NEXT_ACTION, UNRESOLVED_DISCOVERY_TITLE } from './unresolved-discovery';

void React;

export default function UnresolvedDiscoveryNotice() {
  return <section className="mt-6 rounded-2xl border border-[#e2cf93] bg-[#fff8df] p-5 text-[#202840]" role="status" data-testid="status-unresolved-discovery">
    <h2 className="text-base font-bold">{UNRESOLVED_DISCOVERY_TITLE}</h2>
    <p className="mt-2 text-sm leading-6">{UNRESOLVED_DISCOVERY_EXPLANATION}</p>
    <p className="mt-3 text-xs leading-5">{UNRESOLVED_DISCOVERY_NEXT_ACTION}</p>
  </section>;
}