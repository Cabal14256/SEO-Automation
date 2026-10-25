import type { SelectOption } from './select';

const normalize = (text: string) => text.normalize('NFKC').trim().toLocaleLowerCase();

export function filterMultiSelectOptions(options: SelectOption[], query: string): SelectOption[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return options;
  return options.filter((option) => {
    const text = normalize([option.label, ...(option.keywords ?? [])].join(' '));
    return terms.every((term) => text.includes(term));
  });
}
