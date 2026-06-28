import { FieldMetadataType } from 'twenty-shared/types';

import { formatFieldMetadataItemAsFieldDefinition } from '@/object-metadata/utils/formatFieldMetadataItemAsFieldDefinition';
import { type EnrichedObjectMetadataItem } from '@/object-metadata/types/EnrichedObjectMetadataItem';
import { type FieldMetadataItem } from '@/object-metadata/types/FieldMetadataItem';

jest.mock('@/object-record/record-field/ui/utils/getFieldButtonIcon', () => ({
  getFieldButtonIcon: jest.fn().mockReturnValue(undefined),
}));

const mockObjectMetadataItem: Pick<
  EnrichedObjectMetadataItem,
  'nameSingular' | 'namePlural' | 'id'
> &
  Partial<EnrichedObjectMetadataItem> = {
  id: 'object-id',
  nameSingular: 'testObject',
  namePlural: 'testObjects',
  labelIdentifierFieldMetadataId: '',
  fields: [],
  readableFields: [],
  updatableFields: [],
  indexMetadatas: [],
};

const buildField = (overrides: Partial<FieldMetadataItem>): FieldMetadataItem =>
  ({
    id: 'field-id',
    name: 'testField',
    label: 'Test Field',
    type: FieldMetadataType.TEXT,
    icon: undefined,
    isNullable: true,
    isCustom: false,
    isUIReadOnly: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    universalIdentifier: 'test',
    ...overrides,
  }) as FieldMetadataItem;

describe('formatFieldMetadataItemAsFieldDefinition', () => {
  it('uses type-inferred icon when field.icon is null for DATE_TIME', () => {
    const field = buildField({
      type: FieldMetadataType.DATE_TIME,
      icon: null,
    });

    const result = formatFieldMetadataItemAsFieldDefinition({
      field,
      objectMetadataItem: mockObjectMetadataItem as EnrichedObjectMetadataItem,
    });

    expect(result.iconName).toBe('IconCalendarClock');
  });

  it('uses type-inferred icon when field.icon is undefined for SELECT', () => {
    const field = buildField({
      type: FieldMetadataType.SELECT,
      icon: undefined,
    });

    const result = formatFieldMetadataItemAsFieldDefinition({
      field,
      objectMetadataItem: mockObjectMetadataItem as EnrichedObjectMetadataItem,
    });

    expect(result.iconName).toBe('IconTag');
  });

  it('preserves explicit icon and does not override it', () => {
    const field = buildField({
      type: FieldMetadataType.TEXT,
      icon: 'IconCustom',
    });

    const result = formatFieldMetadataItemAsFieldDefinition({
      field,
      objectMetadataItem: mockObjectMetadataItem as EnrichedObjectMetadataItem,
    });

    expect(result.iconName).toBe('IconCustom');
  });
});
