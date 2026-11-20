import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

export interface Team {
  id: string;
  name: string;
  isDefault: boolean;
  myRole: 'admin' | 'member' | null;
  members: number;
  /** How many of its runs may go at once; null: no cap. */
  runLimit: number | null;
}

interface TeamState {
  teams: Team[];
  /** The team lists are filtered to and new Flows go to; '' = all my teams. */
  current: string;
  setCurrent: (id: string) => void;
  reload: () => void;
}

const TeamContext = createContext<TeamState>({ teams: [], current: '', setCurrent: () => undefined, reload: () => undefined });
const KEY = 'dittoly.team';

function stored(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function TeamProvider({ children }: { children: ReactNode }) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [current, setCurrentState] = useState(stored);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    void api<Team[]>('/teams').then(
      (t) => {
        setTeams(t);
        // A remembered team the member no longer belongs to falls back to "all".
        if (current && !t.some((x) => x.id === current)) setCurrentState('');
      },
      () => setTeams([]),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  const setCurrent = (id: string) => {
    setCurrentState(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      // Remembering the choice is a convenience only.
    }
  };
  return <TeamContext.Provider value={{ teams, current, setCurrent, reload: () => setTick((n) => n + 1) }}>{children}</TeamContext.Provider>;
}

export const useTeams = () => useContext(TeamContext);

/** ?team=… for list requests, or '' for all teams. */
export const teamQuery = (current: string, prefix = '?') => (current ? `${prefix}team=${current}` : '');

/** The team picker in the top bar; hidden when the member is in only one team. */
export function TeamSwitcher() {
  const { teams, current, setCurrent } = useTeams();
  if (teams.length < 2) return null;
  return (
    <label className="team-switcher">
      <span className="sr-only">Team</span>
      <select aria-label="Team" value={current} onChange={(e) => setCurrent(e.target.value)}>
        <option value="">All my teams</option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  );
}
