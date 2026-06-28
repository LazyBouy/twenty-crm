import { FieldMetadataType } from 'twenty-shared/types';

// Maps each FieldMetadataType to its preferred icon name.
// Source of truth: aligned with DEFAULT_ICONS_BY_FIELD_TYPE in
// src/pages/settings/data-model/constants/DefaultIconsByFieldType.ts.
// Keep in sync when new FieldMetadataType values are added.
const FIELD_TYPE_ICON_MAP: Partial<Record<FieldMetadataType, string>> = {
  [FieldMetadataType.ADDRESS]: 'IconMap',
  [FieldMetadataType.BOOLEAN]: 'IconToggleLeft',
  [FieldMetadataType.CURRENCY]: 'IconMoneybag',
  [FieldMetadataType.DATE]: 'IconCalendarEvent',
  [FieldMetadataType.DATE_TIME]: 'IconCalendarClock',
  [FieldMetadataType.FILES]: 'IconFile',
  [FieldMetadataType.FULL_NAME]: 'IconUserCircle',
  [FieldMetadataType.MULTI_SELECT]: 'IconTags',
  [FieldMetadataType.NUMBER]: 'IconNumber9',
  [FieldMetadataType.RATING]: 'IconStar',
  [FieldMetadataType.RAW_JSON]: 'IconBraces',
  [FieldMetadataType.RELATION]: 'IconRelationOneToMany',
  [FieldMetadataType.MORPH_RELATION]: 'IconRelationOneToMany',
  [FieldMetadataType.SELECT]: 'IconTag',
  [FieldMetadataType.TEXT]: 'IconTypography',
  [FieldMetadataType.UUID]: 'IconId',
  [FieldMetadataType.ARRAY]: 'IconBracketsContain',
  [FieldMetadataType.EMAILS]: 'IconMail',
  [FieldMetadataType.LINKS]: 'IconWorld',
  [FieldMetadataType.PHONES]: 'IconPhone',
};

export const getDefaultIconForFieldType = (type: FieldMetadataType): string => {
  return FIELD_TYPE_ICON_MAP[type] ?? 'Icon123';
};
