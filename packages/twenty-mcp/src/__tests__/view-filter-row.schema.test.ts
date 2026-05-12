import { z } from 'zod';

import { viewFilterRowSchema } from '../utils/view-filter-row.schema';

describe('viewFilterRowSchema', () => {
  it('rejects row with missing fieldMetadataId', () => {
    expect(() => viewFilterRowSchema.parse({ operand: 'eq' })).toThrow(
      z.ZodError,
    );
  });

  it('rejects row with non-UUID fieldMetadataId', () => {
    expect(() =>
      viewFilterRowSchema.parse({
        fieldMetadataId: 'not-a-uuid',
        operand: 'eq',
      }),
    ).toThrow(z.ZodError);
  });

  it('accepts valid row', () => {
    expect(() =>
      viewFilterRowSchema.parse({
        fieldMetadataId: '00000000-0000-0000-0000-000000000000',
        operand: 'eq',
      }),
    ).not.toThrow();
  });
});
