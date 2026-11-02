export type LicenseId = 'lease' | 'premium' | 'trackout' | 'exclusive';
export type FileKind = 'mp3' | 'wav' | 'stems';

export const LICENSES: Record<LicenseId, { name: string; files: FileKind[]; streams: number | null; terms: string }> = {
  lease: { name: 'Basic lease', files: ['mp3'], streams: 2_500, terms: 'MP3 · 2,500 streams · credit required' },
  premium: { name: 'Premium WAV', files: ['mp3', 'wav'], streams: 10_000, terms: 'MP3 + WAV · 10,000 streams · credit required' },
  trackout: { name: 'Trackout', files: ['mp3', 'wav', 'stems'], streams: 50_000, terms: 'WAV + stems · 50,000 streams · credit required' },
  exclusive: { name: 'Exclusive', files: ['mp3', 'wav', 'stems'], streams: null, terms: 'Unlimited · full rights transfer · beat comes off the store' },
};

export const LICENSE_IDS = Object.keys(LICENSES) as LicenseId[];

/** Default prices (cents) for a new producer; each producer changes them in Settings › Store. */
export const DEFAULT_PRICES: Record<LicenseId, number> = { lease: 2999, premium: 4999, trackout: 9999, exclusive: 75000 };
