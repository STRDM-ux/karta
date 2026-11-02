export type Role = "producer" | "buyer";
export type LicenseId = "lease" | "premium" | "trackout" | "exclusive";

export interface PersonCard { id: string; handle: string; name: string; avatar: string; role: Role }

export interface Offer { id: LicenseId; name: string; files: string[]; streams: number | null; terms: string; price: number }

export interface Beat {
  id: string; title: string; bpm: number; key: string; genre: string; tags: string[]; description: string;
  status: "draft" | "live" | "sold"; prices: Partial<Record<LicenseId, number>>; plays: number; createdAt: number; publishedAt: number;
  cover: string; preview: string; art: Record<string, string>; producer: PersonCard | null; favorited: boolean;
  offers?: Offer[]; from?: number; files?: string[]; soldTo?: string; sales?: number; owned?: LicenseId[]; moreFromProducer?: Beat[];
}

export interface Settings {
  notifications: { sales: boolean; follows: boolean; likes: boolean; weeklyDigest: boolean };
  privacy: { showPurchases: boolean; showFollowing: boolean };
  store: { prices: Record<LicenseId, number>; offered: Record<LicenseId, boolean>; freeDownloads: boolean };
  autoPostBeats: boolean;
}

export interface Me {
  id: string; email: string; role: Role; handle: string; name: string; bio: string; avatar: string; banner: string; location: string;
  genres: string[]; links: Record<string, string>; settings: Settings; payouts: { connected: boolean; ready: boolean };
}

export interface Profile {
  id: string; handle: string; name: string; bio: string; avatar: string; banner: string; location: string; role: Role;
  genres: string[]; links: Record<string, string>; followers: number; following: number; followedByMe: boolean; isMe: boolean;
  beats?: Beat[]; collection?: Beat[]; offered?: Partial<Record<LicenseId, Offer>>; payoutsReady?: boolean;
  stats: { beats?: number; plays?: number; sales?: number; purchases?: number; favorites?: number };
}

export interface Post {
  id: string; targetId: string; kind: "text" | "beat"; createdAt: number; caption: string; author: PersonCard | null; repostedBy: PersonCard | null;
  beat: Beat | null; likes: number; reposts: number; liked: boolean; mine: boolean;
}

export interface Purchase {
  id: string; license: LicenseId; licenseName: string; terms: string; amount: number; paidAt: number; downloads: number;
  beat: Beat | null; files: { kind: string; url: string }[]; agreement: string;
}

export interface ChartEntry { pos: number; move: string; artist: string; title: string; artwork: string; url: string }
export interface Chart { title: string; updated: string; source: { name: string; url: string }; items: ChartEntry[] }
