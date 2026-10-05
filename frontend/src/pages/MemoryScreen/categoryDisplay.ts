import {
  Briefcase,
  Heart,
  HeartPulse,
  IdCard,
  KeyRound,
  type LucideIcon,
  MapPin,
  StickyNote,
  Tag,
  Users,
} from 'lucide-react';

interface CategoryDisplay {
  Icon: LucideIcon;
  label: string;
}

const CATEGORY_DISPLAYS: Record<string, CategoryDisplay> = {
  identity: { Icon: IdCard, label: 'Identity' },
  preference: { Icon: Heart, label: 'Preference' },
  health: { Icon: HeartPulse, label: 'Health' },
  relationships: { Icon: Users, label: 'Relationships' },
  work: { Icon: Briefcase, label: 'Work' },
  location: { Icon: MapPin, label: 'Location' },
  credentials: { Icon: KeyRound, label: 'Credentials' },
  other: { Icon: StickyNote, label: 'Other' },
};

/** Icon and readable name for a Fact category; unknown categories get a generic tag. */
export function categoryDisplay(category: string): CategoryDisplay {
  return CATEGORY_DISPLAYS[category] ?? { Icon: Tag, label: category };
}
