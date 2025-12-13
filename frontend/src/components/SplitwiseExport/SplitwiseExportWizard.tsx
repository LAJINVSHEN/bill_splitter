import React, { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/UI/Modal';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/UI/Card';
import { Button } from '@/components/UI/Button';
import { Input } from '@/components/UI/Input';
import { Select } from '@/components/UI/Select';
import { splitwiseService, SplitwiseGroup, SplitwiseMe } from '@/services/splitwiseService';
import { PersonSplit } from '@/types/split.types';
import { formatCurrency } from '@/utils/formatters';
import { ArrowRight, CheckCircle2, ExternalLink, Users, XCircle, Sparkles } from 'lucide-react';

type StepId = 'connect' | 'group' | 'mapping' | 'preview' | 'done';

export interface SplitwiseExportWizardProps {
  isOpen: boolean;
  onClose: () => void;
  personSplits: PersonSplit[];
  totalBill: number;
}

const roundToCents = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

const formatMoneyString = (value: number) => roundToCents(value).toFixed(2);

export const SplitwiseExportWizard: React.FC<SplitwiseExportWizardProps> = ({
  isOpen,
  onClose,
  personSplits,
  totalBill,
}) => {
  const [step, setStep] = useState<StepId>('connect');
  const [error, setError] = useState<string | null>(null);

  const [apiKey, setApiKey] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);

  const [sessionId, setSessionId] = useState<string | null>(() => localStorage.getItem('splitwise_session_id'));
  const [me, setMe] = useState<SplitwiseMe | null>(null);

  const [groups, setGroups] = useState<SplitwiseGroup[]>([]);
  const [isLoadingGroups, setIsLoadingGroups] = useState(false);
  const [groupQuery, setGroupQuery] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);

  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [paidByUserId, setPaidByUserId] = useState<Record<number, string>>({});

  const [description, setDescription] = useState(() => `Bill split - ${new Date().toLocaleDateString()}`);
  const [currencyCode, setCurrencyCode] = useState<string>('');
  const [expenseDate, setExpenseDate] = useState<string>('');

  const [isCreatingExpense, setIsCreatingExpense] = useState(false);
  const [createdExpenseId, setCreatedExpenseId] = useState<number | null>(null);

  const steps = useMemo(
    () => [
      { id: 'connect' as const, label: 'Connect' },
      { id: 'group' as const, label: 'Group' },
      { id: 'mapping' as const, label: 'Mapping' },
      { id: 'preview' as const, label: 'Create' },
    ],
    []
  );

  const currentStepIndex = useMemo(() => steps.findIndex((s) => s.id === step), [steps, step]);

  const selectedGroup = useMemo(() => groups.find((g) => g.id === selectedGroupId) || null, [groups, selectedGroupId]);
  const selectedMembers = selectedGroup?.members ?? [];

  const filteredGroups = useMemo(() => {
    const q = groupQuery.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => g.name.toLowerCase().includes(q));
  }, [groups, groupQuery]);

  const isConnected = Boolean(sessionId);

  const canProceedGroup = Boolean(selectedGroupId);
  const canProceedMapping = useMemo(() => {
    if (!selectedGroup) return false;
    return personSplits.every((p) => Boolean(mapping[p.person_id]));
  }, [selectedGroup, personSplits, mapping]);

  const consolidatedShares = useMemo(() => {
    const costCents = Math.round(roundToCents(totalBill) * 100);
    const owedByUserCents = new Map<number, number>();
    const contributorsByUser = new Map<number, string[]>();

    for (const p of personSplits) {
      const userId = mapping[p.person_id];
      if (!userId) continue;
      const owedCents = Math.round(roundToCents(p.total) * 100);
      owedByUserCents.set(userId, (owedByUserCents.get(userId) ?? 0) + owedCents);
      contributorsByUser.set(userId, [...(contributorsByUser.get(userId) ?? []), p.person_name]);
    }

    const shares = Array.from(owedByUserCents.entries()).map(([userId, owedCents]) => ({
      user_id: userId,
      owed_cents: owedCents,
      contributor_names: contributorsByUser.get(userId) ?? [],
    }));

    shares.sort((a, b) => a.user_id - b.user_id);

    const sumOwedCents = shares.reduce((sum, s) => sum + s.owed_cents, 0);
    const delta = costCents - sumOwedCents;
    if (shares.length > 0 && delta !== 0) {
      shares[shares.length - 1] = { ...shares[shares.length - 1], owed_cents: shares[shares.length - 1].owed_cents + delta };
    }

    return {
      cost_cents: costCents,
      shares,
    };
  }, [personSplits, mapping, totalBill]);

  const resetAll = () => {
    setStep('connect');
    setError(null);
    setGroups([]);
    setIsLoadingGroups(false);
    setGroupQuery('');
    setSelectedGroupId(null);
    setMapping({});
    setPaidByUserId({});
    setIsCreatingExpense(false);
    setCreatedExpenseId(null);
  };

  const disconnect = () => {
    localStorage.removeItem('splitwise_session_id');
    setSessionId(null);
    setMe(null);
    resetAll();
  };

  const loadMeAndGroups = async (sid: string) => {
    setError(null);
    try {
      const currentMe = await splitwiseService.me(sid);
      setMe(currentMe);
    } catch (e: any) {
      setMe(null);
      throw e;
    }

    setIsLoadingGroups(true);
    try {
      const list = await splitwiseService.groups(sid);
      setGroups(list);
    } finally {
      setIsLoadingGroups(false);
    }
  };

  const connectWithApiKey = async () => {
    setError(null);
    setIsConnecting(true);
    try {
      const res = await splitwiseService.connect({
        api_key: apiKey.trim(),
      });
      localStorage.setItem('splitwise_session_id', res.session_id);
      setSessionId(res.session_id);
      setMe(res.me);
      setStep('group');
    } catch (e: any) {
      setError(e?.details?.detail || e?.message || 'Failed to connect to Splitwise');
    } finally {
      setIsConnecting(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    if (!sessionId) return;

    (async () => {
      try {
        await loadMeAndGroups(sessionId);
        setStep('group');
      } catch (e: any) {
        setError(e?.message || 'Failed to connect to Splitwise. Please reconnect.');
        disconnect();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, sessionId]);

  useEffect(() => {
    if (!isOpen) return;
    if (!selectedGroup) return;

    const nextMapping: Record<string, number> = { ...mapping };
    const membersByName = new Map<string, number>();
    for (const m of selectedMembers) {
      membersByName.set(m.display_name.toLowerCase(), m.id);
      if (m.email) membersByName.set(m.email.toLowerCase(), m.id);
    }

    let changed = false;
    for (const p of personSplits) {
      if (nextMapping[p.person_id]) continue;
      const matchId = membersByName.get(p.person_name.toLowerCase());
      if (matchId) {
        nextMapping[p.person_id] = matchId;
        changed = true;
      }
    }

    if (changed) setMapping(nextMapping);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, selectedGroupId]);

  useEffect(() => {
    if (!isOpen) return;
    if (step !== 'preview') return;
    if (!selectedGroup) return;

    // Initialize paid shares to "everyone paid their own share" (editable).
    setPaidByUserId((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      const next: Record<number, string> = {};
      for (const s of consolidatedShares.shares) {
        next[s.user_id] = (s.owed_cents / 100).toFixed(2);
      }
      return next;
    });
  }, [isOpen, step, selectedGroup, consolidatedShares.shares]);

  const closeAndReset = () => {
    resetAll();
    onClose();
  };

  const goNext = () => {
    setError(null);
    if (step === 'connect') setStep('group');
    else if (step === 'group') setStep('mapping');
    else if (step === 'mapping') setStep('preview');
    else if (step === 'preview') setStep('done');
  };

  const goBack = () => {
    setError(null);
    if (step === 'group') setStep('connect');
    else if (step === 'mapping') setStep('group');
    else if (step === 'preview') setStep('mapping');
  };

  const createExpense = async () => {
    if (!sessionId || !selectedGroupId) return;

    setIsCreatingExpense(true);
    setError(null);
    try {
      const costStr = (consolidatedShares.cost_cents / 100).toFixed(2);
      const costCents = consolidatedShares.cost_cents;
      const paidSumCents = consolidatedShares.shares.reduce((sum, s) => {
        const raw = (paidByUserId[s.user_id] ?? '').trim();
        const paid = raw ? Number(raw) : 0;
        const paidCents = Number.isFinite(paid) ? Math.round(roundToCents(paid) * 100) : 0;
        return sum + paidCents;
      }, 0);

      if (paidSumCents !== costCents) {
        const delta = (costCents - paidSumCents) / 100;
        throw new Error(`Paid totals must equal the bill total. Difference: ${delta.toFixed(2)}`);
      }

      const shares = consolidatedShares.shares.map((s) => ({
        user_id: s.user_id,
        owed_share: (s.owed_cents / 100).toFixed(2),
        paid_share: (() => {
          const raw = (paidByUserId[s.user_id] ?? '').trim();
          const paid = raw ? Number(raw) : 0;
          return Number.isFinite(paid) ? formatMoneyString(paid) : '0.00';
        })(),
      }));

      const res = await splitwiseService.createExpense({
        session_id: sessionId,
        group_id: selectedGroupId,
        description: description.trim() || 'Bill split',
        cost: costStr,
        currency_code: currencyCode.trim() || undefined,
        date: expenseDate.trim() || undefined,
        shares,
      });

      setCreatedExpenseId(res.expense_id);
      setStep('done');
    } catch (e: any) {
      setError(e?.details?.detail || e?.message || 'Failed to create Splitwise expense');
    } finally {
      setIsCreatingExpense(false);
    }
  };

  const memberOptions = useMemo(
    () =>
      selectedMembers.map((m) => ({
        value: String(m.id),
        label: m.display_name,
      })),
    [selectedMembers]
  );

  const paidSummary = useMemo(() => {
    const paidCents = consolidatedShares.shares.reduce((sum, s) => {
      const raw = (paidByUserId[s.user_id] ?? '').trim();
      const paid = raw ? Number(raw) : 0;
      const cents = Number.isFinite(paid) ? Math.round(roundToCents(paid) * 100) : 0;
      return sum + cents;
    }, 0);

    const deltaCents = consolidatedShares.cost_cents - paidCents;
    return {
      paid_cents: paidCents,
      delta_cents: deltaCents,
    };
  }, [paidByUserId, consolidatedShares]);

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={closeAndReset} title="Export to Splitwise" size="xl">
      <div className="space-y-4 sm:space-y-5">
        <div className="rounded-xl bg-gradient-to-r from-primary-600 to-indigo-600 p-4 sm:p-5 text-white shadow-sm">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="text-xs sm:text-sm opacity-90">Create a Splitwise expense</div>
              <div className="text-lg sm:text-xl font-semibold leading-tight">Export this bill split</div>
              <div className="text-sm opacity-90">
                Total: <span className="font-medium">{formatCurrency(totalBill)}</span>
              </div>
            </div>
            <div className="hidden md:flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2">
              <Users className="h-4 w-4" />
              <span className="text-sm">{personSplits.length} participants</span>
            </div>
          </div>
        </div>

        {/* Stepper */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {steps.map((s, idx) => {
            const isActive = s.id === step;
            const isDone = currentStepIndex > idx;
            return (
              <div
                key={s.id}
                className={[
                  'rounded-lg border px-3 py-2',
                  isActive ? 'border-primary-300 bg-primary-50' : 'border-gray-200 bg-white',
                ].join(' ')}
              >
                <div className="flex items-center gap-2">
                  {isDone ? (
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                  ) : isActive ? (
                    <div className="h-4 w-4 rounded-full bg-primary-600" />
                  ) : (
                    <div className="h-4 w-4 rounded-full bg-gray-300" />
                  )}
                  <div className="text-sm font-medium text-gray-900">{s.label}</div>
                </div>
              </div>
            );
          })}
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-start gap-2">
            <XCircle className="h-4 w-4 mt-0.5" />
            <div>{error}</div>
          </div>
        )}

        {/* CONNECT */}
        {step === 'connect' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Credentials</CardTitle>
                <CardDescription>Paste your Splitwise API key to connect.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-sm text-gray-600">
                  Log in to Splitwise here:{' '}
                  <a
                    href="https://secure.splitwise.com/login"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary-700 hover:text-primary-800 underline"
                  >
                    https://secure.splitwise.com/login
                  </a>
                </div>
                <Input
                  label="SPLITWISE_API_KEY"
                  helperText="We store this only in memory on the server (temporary session)."
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    onClick={connectWithApiKey}
                    isLoading={isConnecting}
                    disabled={!apiKey.trim()}
                    leftIcon={<ExternalLink className="h-4 w-4" />}
                  >
                    Connect
                  </Button>
                  {isConnected && (
                    <Button variant="outline" onClick={disconnect}>
                      Disconnect
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Status</CardTitle>
                <CardDescription>Once connected, we’ll load your groups and members.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                  <div className="text-sm text-gray-600">Connection</div>
                  <div className="mt-1 font-medium text-gray-900">{isConnected ? 'Connected' : 'Not connected'}</div>
                </div>
                {me && (
                  <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                    <div className="text-sm text-green-800">Signed in as</div>
                    <div className="mt-1 font-semibold text-green-900">{me.display_name}</div>
                    {me.email && <div className="text-sm text-green-800">{me.email}</div>}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* GROUP */}
        {step === 'group' && (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Choose a group</CardTitle>
                <CardDescription>Select the Splitwise group to create the expense in.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-col md:flex-row gap-3 md:items-end">
                  <Input
                    label="Search groups"
                    placeholder="e.g. Japan Trip"
                    value={groupQuery}
                    onChange={(e) => setGroupQuery(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={async () => {
                        if (!sessionId) return;
                        setError(null);
                        setIsLoadingGroups(true);
                        try {
                          const list = await splitwiseService.groups(sessionId);
                          setGroups(list);
                        } catch (e: any) {
                          setError(e?.message || 'Failed to load groups');
                        } finally {
                          setIsLoadingGroups(false);
                        }
                      }}
                      isLoading={isLoadingGroups}
                    >
                      Refresh
                    </Button>
                    <Button variant="outline" onClick={disconnect}>
                      Disconnect
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {filteredGroups.map((g) => {
                    const selected = g.id === selectedGroupId;
                    return (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => setSelectedGroupId(g.id)}
                        className={[
                          'text-left rounded-xl border p-4 transition-all',
                          selected
                            ? 'border-primary-400 bg-primary-50 shadow-sm'
                            : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm',
                        ].join(' ')}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="font-semibold text-gray-900">{g.name}</div>
                            <div className="text-sm text-gray-600">{g.members.length} members</div>
                          </div>
                          {selected && <CheckCircle2 className="h-5 w-5 text-primary-600" />}
                        </div>
                      </button>
                    );
                  })}
                  {filteredGroups.length === 0 && (
                    <div className="text-sm text-gray-600">No groups found.</div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* MAPPING */}
        {step === 'mapping' && selectedGroup && (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Map participants</CardTitle>
                <CardDescription>Match each participant to a Splitwise group member.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                  <div className="text-sm text-gray-600">Selected group</div>
                  <div className="mt-1 font-semibold text-gray-900">{selectedGroup.name}</div>
                  <div className="text-sm text-gray-600">{selectedMembers.length} members</div>
                </div>

                <div className="grid grid-cols-1 gap-3">
                  {personSplits.map((p) => (
                    <div key={p.person_id} className="rounded-xl border border-gray-200 bg-white p-4">
                      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                        <div>
                          <div className="font-semibold text-gray-900">{p.person_name}</div>
                          <div className="text-sm text-gray-600">Owes {formatCurrency(p.total)}</div>
                        </div>
                        <div className="w-full md:max-w-sm">
                          <Select
                            label="Splitwise member"
                            value={mapping[p.person_id] ? String(mapping[p.person_id]) : ''}
                            onChange={(e) => setMapping((prev) => ({ ...prev, [p.person_id]: Number(e.target.value) }))}
                            options={memberOptions}
                            placeholder="Select member"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* PREVIEW */}
        {step === 'preview' && selectedGroup && (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Expense details</CardTitle>
                <CardDescription>Confirm who paid what and create the expense.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
                  <Input
                    label="Currency (optional)"
                    placeholder="e.g. USD"
                    value={currencyCode}
                    onChange={(e) => setCurrencyCode(e.target.value.toUpperCase())}
                  />
                  <Input
                    label="Date (optional)"
                    placeholder="YYYY-MM-DD"
                    value={expenseDate}
                    onChange={(e) => setExpenseDate(e.target.value)}
                  />
                </div>

                <div className="rounded-xl border border-gray-200 overflow-hidden">
                  <div className="bg-gray-50 px-4 py-3 flex items-center justify-between">
                    <div className="font-semibold text-gray-900">Split preview</div>
                    <div className="text-sm text-gray-600">Total {formatCurrency(totalBill)}</div>
                  </div>
                  <div className="divide-y divide-gray-200">
                    {consolidatedShares.shares.map((s) => {
                      const member = selectedMembers.find((m) => m.id === s.user_id);
                      const owed = s.owed_cents / 100;
                      const paidRaw = (paidByUserId[s.user_id] ?? '').trim();
                      const paid = paidRaw ? Number(paidRaw) : 0;
                      return (
                        <div key={s.user_id} className="px-4 py-3 flex items-center justify-between gap-3">
                          <div>
                            <div className="font-medium text-gray-900">{member?.display_name ?? `User ${s.user_id}`}</div>
                            {s.contributor_names.length > 0 && (
                              <div className="text-sm text-gray-600">From: {s.contributor_names.join(', ')}</div>
                            )}
                          </div>
                          <div className="text-right min-w-[220px]">
                            <div className="text-sm text-gray-600">
                              Owed <span className="font-semibold text-gray-900">{formatCurrency(owed)}</span>
                            </div>
                            <div className="mt-2">
                              <Input
                                label="Paid"
                                inputMode="decimal"
                                placeholder="0.00"
                                value={paidByUserId[s.user_id] ?? ''}
                                onChange={(e) =>
                                  setPaidByUserId((prev) => ({
                                    ...prev,
                                    [s.user_id]: e.target.value,
                                  }))
                                }
                              />
                              <div className="mt-1 text-xs text-gray-500">Current: {formatCurrency(Number.isFinite(paid) ? paid : 0)}</div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-xl border border-gray-200 bg-white p-4">
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                    <div>
                      <div className="font-semibold text-gray-900 flex items-center gap-2">
                        <Sparkles className="h-4 w-4 text-primary-700" />
                        Paid summary
                      </div>
                      <div className="text-sm text-gray-600">
                        Paid total {formatCurrency(paidSummary.paid_cents / 100)} • Difference{' '}
                        <span className={paidSummary.delta_cents === 0 ? 'text-green-700 font-medium' : 'text-red-700 font-medium'}>
                          {formatCurrency(paidSummary.delta_cents / 100)}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        onClick={() => {
                          const next: Record<number, string> = {};
                          for (const s of consolidatedShares.shares) next[s.user_id] = '0.00';
                          setPaidByUserId(next);
                        }}
                      >
                        Clear paid
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          const next: Record<number, string> = {};
                          for (const s of consolidatedShares.shares) next[s.user_id] = (s.owed_cents / 100).toFixed(2);
                          setPaidByUserId(next);
                        }}
                      >
                        Everyone paid own share
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    onClick={createExpense}
                    isLoading={isCreatingExpense}
                    disabled={!canProceedMapping || paidSummary.delta_cents !== 0}
                  >
                    Create Splitwise Expense
                  </Button>
                  <div className="text-sm text-gray-600">
                    Cost: <span className="font-medium">{formatMoneyString(totalBill)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* DONE */}
        {step === 'done' && (
          <Card>
            <CardHeader>
              <CardTitle>Export complete</CardTitle>
              <CardDescription>Your Splitwise expense has been created.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                <div className="text-sm text-green-800">Created expense</div>
                <div className="mt-1 text-xl font-semibold text-green-900">
                  {createdExpenseId ? `#${createdExpenseId}` : 'Success'}
                </div>
              </div>
              <div className="flex gap-2">
                <Button onClick={closeAndReset}>Close</Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setCreatedExpenseId(null);
                    setStep('group');
                  }}
                >
                  Export again
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Footer nav */}
        {step !== 'done' && (
          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={goBack} disabled={step === 'connect'}>
              Back
            </Button>
            <div className="flex items-center gap-2">
              {step === 'connect' && (
                <Button
                  onClick={() => setStep('group')}
                  disabled={!isConnected}
                  rightIcon={<ArrowRight className="h-4 w-4" />}
                >
                  Continue
                </Button>
              )}
              {step === 'group' && (
                <Button
                  onClick={goNext}
                  disabled={!canProceedGroup}
                  rightIcon={<ArrowRight className="h-4 w-4" />}
                >
                  Continue
                </Button>
              )}
              {step === 'mapping' && (
                <Button
                  onClick={goNext}
                  disabled={!canProceedMapping}
                  rightIcon={<ArrowRight className="h-4 w-4" />}
                >
                  Continue
                </Button>
              )}
              {step === 'preview' && (
                <Button variant="outline" onClick={closeAndReset}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
};
