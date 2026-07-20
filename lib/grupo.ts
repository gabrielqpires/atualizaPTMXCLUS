export const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI',
  'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU',
  'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

function token(value: unknown): string {
  return String(value ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function inferirGrupo(paisDestino: unknown): string {
  if (paisDestino === true) return 'EU';
  if (paisDestino === false) return 'Non-EU';

  const raw = String(paisDestino ?? '').trim().toUpperCase();
  const normalized = token(paisDestino);
  if (!normalized) return '';

  if (['EU', 'UE', 'EUROPEANUNION', 'UNIAOEUROPEIA', 'SIM', 'TRUE', 'YES', '1'].includes(normalized)) return 'EU';
  if (['NONEU', 'NONUE', 'NAOEU', 'NAOUE', 'FORAEU', 'FORAUE', 'OUTSIDEEU', 'FALSE', 'NO', '0'].includes(normalized)) return 'Non-EU';

  return EU_COUNTRIES.has(raw) ? 'EU' : 'Non-EU';
}
