import { categoryDisplay } from '@/components/memory/categoryDisplay';
import {
  FACT_CATEGORIES,
  type UserSettings,
  fetchUserSettings,
  updateUserSettings,
} from '@/services/api';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

export default function SettingsPage() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const loadSettings = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchUserSettings();
      setSettings(data);
    } catch (error) {
      toast.error('Failed to load settings', {
        description: (error as Error).message,
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleMemoryToggle = async (enabled: boolean) => {
    if (!settings) return;
    setIsSaving(true);
    try {
      const updated = await updateUserSettings({ memoryEnabled: enabled });
      setSettings(updated);
      toast.success(enabled ? 'Memory enabled' : 'Memory disabled');
    } catch (error) {
      toast.error('Failed to update settings', {
        description: (error as Error).message,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCategoryToggle = async (category: string, blocked: boolean) => {
    if (!settings) return;
    setIsSaving(true);
    try {
      const newBlocked = blocked
        ? [...settings.memoryBlockedCategories, category]
        : settings.memoryBlockedCategories.filter((c) => c !== category);
      const updated = await updateUserSettings({ memoryBlockedCategories: newBlocked });
      setSettings(updated);
      const { label } = categoryDisplay(category);
      toast.success(blocked ? `Blocked ${label}` : `Unblocked ${label}`);
    } catch (error) {
      toast.error('Failed to update settings', {
        description: (error as Error).message,
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading settings...</div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Failed to load settings</div>
      </div>
    );
  }

  return (
    <div className="scrollbar-slim flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your memory and privacy preferences
          </p>
        </div>

        <div className="space-y-6">
          {/* Memory Enable/Disable */}
          <section className="rounded-lg border border-border bg-card p-6">
            <h2 className="text-lg font-semibold text-foreground">Memory</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Control whether the assistant remembers facts about you from conversations
            </p>
            <div className="mt-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">Enable memory</p>
                <p className="text-xs text-muted-foreground">
                  When disabled, no new facts will be captured and existing facts won't be used
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleMemoryToggle(!settings.memoryEnabled)}
                disabled={isSaving}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  settings.memoryEnabled ? 'bg-primary' : 'bg-secondary'
                } disabled:opacity-50`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${
                    settings.memoryEnabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </section>

          {/* Blocked Categories */}
          <section className="rounded-lg border border-border bg-card p-6">
            <h2 className="text-lg font-semibold text-foreground">Blocked Categories</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Facts in blocked categories are never captured or used in conversations
            </p>
            <div className="mt-4 space-y-3">
              {FACT_CATEGORIES.map((category) => {
                const isBlocked = settings.memoryBlockedCategories.includes(category);
                return (
                  <div
                    key={category}
                    className="flex items-center justify-between rounded border border-border bg-muted/20 p-3"
                  >
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {categoryDisplay(category).label}
                      </p>
                      {category === 'credentials' && (
                        <p className="text-xs text-muted-foreground">
                          Blocked by default for security
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleCategoryToggle(category, !isBlocked)}
                      disabled={isSaving}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        isBlocked ? 'bg-destructive' : 'bg-secondary'
                      } disabled:opacity-50`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${
                          isBlocked ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
