import React, { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { Input } from './Input';
import { BillItem } from '@/types/bill.types';
import { Person } from '@/types/person.types';
import { ItemSplit } from '@/hooks/useItemAssignment';
import { formatCurrency } from '@/utils/formatters';
import { AlertCircle } from 'lucide-react';

export interface SplitChoiceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (splitType: 'equal' | 'unequal', customSplits?: ItemSplit[]) => void;
  item: BillItem;
  personIds: string[];
  participants: Person[];
}

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

const fairDivideCents = (amountCents: number, people: number): number[] => {
  const q = Math.floor(amountCents / people);
  const r = amountCents % people;
  const shares = Array(people).fill(q);
  for (let i = 0; i < r; i++) shares[i] += 1;
  return shares;
};

const formatAmountInput = (value: number) => {
  if (!Number.isFinite(value)) return '';
  return value === 0 ? '' : String(value);
};

export const SplitChoiceModal: React.FC<SplitChoiceModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  item,
  personIds,
  participants,
}) => {
  const [splitType, setSplitType] = useState<'equal' | 'unequal'>('equal');
  const [customSplits, setCustomSplits] = useState<ItemSplit[]>([]);
  const [error, setError] = useState<string>('');
  const [amountDrafts, setAmountDrafts] = useState<Record<string, string>>({});

  const getPersonName = (personId: string) => {
    return participants.find((p) => p.id === personId)?.name || 'Unknown';
  };

  useEffect(() => {
    if (!isOpen) return;
    setSplitType('equal');
    setError('');

    const totalCents = Math.round((item.total_price || 0) * 100);
    const sharesCents = fairDivideCents(totalCents, Math.max(1, personIds.length));
    const initialSplits = personIds.map((personId, index) => {
      const amount = sharesCents[index] / 100;
      return {
        personId,
        amount: roundMoney(amount),
        percentage: item.total_price ? roundMoney((amount / item.total_price) * 100) : 0,
      };
    });
    setCustomSplits(initialSplits);
    setAmountDrafts(
      initialSplits.reduce<Record<string, string>>((acc, split) => {
        acc[split.personId] = formatAmountInput(split.amount);
        return acc;
      }, {})
    );
  }, [isOpen, item.total_price, personIds, participants]);

  const customTotal = useMemo(() => {
    return roundMoney(customSplits.reduce((sum, split) => sum + (split.amount || 0), 0));
  }, [customSplits]);

  const remaining = useMemo(() => {
    return roundMoney((item.total_price || 0) - customTotal);
  }, [item.total_price, customTotal]);

  const validateCustom = () => {
    if (!Number.isFinite(item.total_price) || item.total_price <= 0) {
      return 'Item total must be a positive number.';
    }
    if (personIds.length < 2) {
      return 'Select at least two people to split.';
    }
    if (customSplits.some((s) => !Number.isFinite(s.amount) || s.amount < 0)) {
      return 'All split amounts must be 0 or greater.';
    }
    const centsDiff = Math.round(customTotal * 100) - Math.round(item.total_price * 100);
    if (centsDiff !== 0) {
      return `Split must equal item total (remaining ${formatCurrency(remaining)}).`;
    }
    return '';
  };

  const updateSplitAmount = (personId: string, nextAmount: number) => {
    setCustomSplits((prev) => {
      const updated = prev.map((split) => {
        if (split.personId !== personId) return split;
        const amount = roundMoney(nextAmount);
        return {
          ...split,
          amount,
          percentage: item.total_price ? roundMoney((amount / item.total_price) * 100) : 0,
        };
      });
      return updated;
    });
    setError('');
  };

  const handleAmountChange = (personId: string, rawValue: string) => {
    // Allow digits with optional single dot, including trailing dot while typing.
    const validPattern = /^(\d+(\.\d*)?|\.\d*)$/;
    if (rawValue !== '' && !validPattern.test(rawValue.trim())) {
      return; // ignore invalid keystrokes to keep focus stable
    }

    setAmountDrafts((prev) => ({ ...prev, [personId]: rawValue }));

    const parsed = rawValue.trim() === '' ? 0 : parseFloat(rawValue);
    const safeAmount = Number.isFinite(parsed) ? parsed : 0;
    updateSplitAmount(personId, safeAmount);
  };

  const handleAmountBlur = (personId: string) => {
    setAmountDrafts((prev) => {
      const current = prev[personId];
      if (current === undefined) return prev;
      const parsed = current.trim() === '' ? 0 : parseFloat(current);
      const normalized = Number.isFinite(parsed) ? roundMoney(parsed) : 0;
      updateSplitAmount(personId, normalized);
      return { ...prev, [personId]: formatAmountInput(normalized) };
    });
  };

  const handleConfirm = () => {
    if (splitType === 'equal') {
      onConfirm('equal');
      return;
    }

    const nextError = validateCustom();
    if (nextError) {
      setError(nextError);
      return;
    }

    onConfirm('unequal', customSplits);
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Split Item" size="lg">
      <div className="space-y-4">
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-gray-600">Item</div>
              <div className="font-medium text-gray-900 truncate">{item.name}</div>
            </div>
            <div className="text-right">
              <div className="text-sm text-gray-600">Total</div>
              <div className="font-semibold text-gray-900">{formatCurrency(item.total_price)}</div>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium text-gray-700">How should this item be split?</div>
          <div className="flex flex-col sm:flex-row gap-2">
            <label className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 cursor-pointer">
              <input
                type="radio"
                name="splitType"
                checked={splitType === 'equal'}
                onChange={() => setSplitType('equal')}
              />
              <span className="text-sm text-gray-800">Equal split</span>
            </label>
            <label className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 cursor-pointer">
              <input
                type="radio"
                name="splitType"
                checked={splitType === 'unequal'}
                onChange={() => setSplitType('unequal')}
              />
              <span className="text-sm text-gray-800">Custom amounts</span>
            </label>
          </div>
        </div>

        {splitType === 'unequal' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-gray-700">Custom amounts</div>
              <div className="text-sm text-gray-600">
                Remaining: <span className={Math.abs(remaining) < 0.01 ? 'text-green-700' : 'text-red-600'}>{formatCurrency(remaining)}</span>
              </div>
            </div>

            <div className="space-y-2">
              {customSplits.map((split) => (
                <div key={split.personId} className="rounded-lg border border-gray-200 p-3">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-gray-900 truncate">{getPersonName(split.personId)}</div>
                        <div className="text-xs text-gray-500">{split.percentage.toFixed(1)}%</div>
                      </div>
                    <div className="w-full sm:w-52">
                      <Input
                        type="text"
                        inputMode="decimal"
                        placeholder="0.00"
                      value={amountDrafts[split.personId] ?? formatAmountInput(split.amount)}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => handleAmountChange(split.personId, e.target.value)}
                      onBlur={() => handleAmountBlur(split.personId)}
                      className="text-sm"
                    />
                  </div>
                </div>
              </div>
            ))}
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-5 w-5 text-red-500 mt-0.5" />
              <div className="text-sm text-red-700">{error}</div>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="outline" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button onClick={handleConfirm} type="button">
            Confirm
          </Button>
        </div>
      </div>
    </Modal>
  );
};
