import { FieldMetadataType } from 'twenty-shared/types';

import { getDefaultIconForFieldType } from '@/object-metadata/utils/getDefaultIconForFieldType';

describe('getDefaultIconForFieldType', () => {
  it('returns IconCalendarClock for DATE_TIME', () => {
    expect(getDefaultIconForFieldType(FieldMetadataType.DATE_TIME)).toBe(
      'IconCalendarClock',
    );
  });

  it('returns IconTag for SELECT', () => {
    expect(getDefaultIconForFieldType(FieldMetadataType.SELECT)).toBe(
      'IconTag',
    );
  });

  it('returns IconTypography for TEXT', () => {
    expect(getDefaultIconForFieldType(FieldMetadataType.TEXT)).toBe(
      'IconTypography',
    );
  });

  it('returns IconToggleLeft for BOOLEAN', () => {
    expect(getDefaultIconForFieldType(FieldMetadataType.BOOLEAN)).toBe(
      'IconToggleLeft',
    );
  });

  it('returns IconRelationOneToMany for RELATION', () => {
    expect(getDefaultIconForFieldType(FieldMetadataType.RELATION)).toBe(
      'IconRelationOneToMany',
    );
  });

  it('returns IconMail for EMAILS', () => {
    expect(getDefaultIconForFieldType(FieldMetadataType.EMAILS)).toBe(
      'IconMail',
    );
  });

  it('returns IconPhone for PHONES', () => {
    expect(getDefaultIconForFieldType(FieldMetadataType.PHONES)).toBe(
      'IconPhone',
    );
  });

  it('returns IconStar for RATING', () => {
    expect(getDefaultIconForFieldType(FieldMetadataType.RATING)).toBe(
      'IconStar',
    );
  });

  it('returns IconWorld for LINKS', () => {
    expect(getDefaultIconForFieldType(FieldMetadataType.LINKS)).toBe(
      'IconWorld',
    );
  });

  it('returns IconNumber9 for NUMBER (not Icon123 — numbers icon preserved for NUMBER type)', () => {
    expect(getDefaultIconForFieldType(FieldMetadataType.NUMBER)).toBe(
      'IconNumber9',
    );
  });

  it('returns Icon123 fallback for NUMERIC (unmapped type)', () => {
    expect(getDefaultIconForFieldType(FieldMetadataType.NUMERIC)).toBe(
      'Icon123',
    );
  });

  it('returns Icon123 fallback for ACTOR (unmapped type)', () => {
    expect(getDefaultIconForFieldType(FieldMetadataType.ACTOR)).toBe('Icon123');
  });
});
