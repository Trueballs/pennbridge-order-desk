import { describe, expect, it } from 'vitest';
import { statusRoute, unsupportedSetup } from '../scripts/evaluate';

describe('offline acceptance harness boundaries',()=>{
  it('maps the domain status to the fixture route vocabulary',()=>{
    expect(statusRoute('draft_ready')).toBe('draft_ready');
    expect(statusRoute('not_order')).toBe('not_order');
    expect(statusRoute('needs_review')).toBe('needs_review');
  });
  it('excludes stateful fixtures the pure domain interface cannot seed',()=>{
    expect(unsupportedSetup({trusted_ingestion_context:{verified_customer_id:'C001'}})).toEqual([]);
    expect(unsupportedSetup({existing_order:{},historical_orders:[],processed_message_ids:[]}))
      .toEqual(['existing_order','historical_orders','processed_message_ids']);
  });
});
