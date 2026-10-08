import React, { useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardTitle } from '@/components/UI/Card';
import { Button } from '@/components/UI/Button';
import { PersonSplit } from '@/types/split.types';
import { formatCurrency } from '@/utils/formatters';
import { downloadFile } from '@/utils/fileHelpers';
import { toPng } from 'html-to-image';
import { Receipt, User, Calculator, Download, Share2, Users, Copy, Send } from 'lucide-react';
import { SplitwiseExportWizard } from '@/components/SplitwiseExport/SplitwiseExportWizard';

export interface SplitSummaryProps {
  personSplits: PersonSplit[];
  totalBill: number;
  totalTax: number;
  totalServiceCharge: number;
  totalDiscount: number;
  onStartOver: () => void;
  onModifyAssignment: () => void;
  onShare: () => void;
  disabled?: boolean;
}

export const SplitSummary: React.FC<SplitSummaryProps> = ({
  personSplits,
  totalBill,
  totalTax,
  totalServiceCharge,
  totalDiscount,
  onStartOver,
  onModifyAssignment,
  onShare,
  disabled = false,
}) => {
  const exportRootRef = useRef<HTMLDivElement | null>(null);
  const personCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [copiedByPersonId, setCopiedByPersonId] = useState<Record<string, boolean>>({});
  const [isExportingPngByPersonId, setIsExportingPngByPersonId] = useState<Record<string, boolean>>({});
  const [isExportingAllPng, setIsExportingAllPng] = useState(false);
  const [isCopyingAll, setIsCopyingAll] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  const [isSplitwiseWizardOpen, setIsSplitwiseWizardOpen] = useState(false);

  const handlePrint = () => {
    window.print();
  };

  const canExport = useMemo(() => {
    return typeof window !== 'undefined';
  }, []);

  const exportFilter = (node: HTMLElement) => {
    return node.dataset?.exportIgnore !== 'true';
  };

  const getExportOptionsForNode = (node: HTMLElement) => {
    const rect = node.getBoundingClientRect();
    const width = Math.ceil(rect.width);
    const height = Math.ceil(node.scrollHeight || rect.height);

    return {
      cacheBust: true,
      pixelRatio: 2,
      backgroundColor: '#ffffff',
      filter: exportFilter,
      width,
      height,
      style: {
        marginLeft: '0',
        marginRight: '0',
        width: `${width}px`,
        height: `${height}px`,
      } as Record<string, string>,
    };
  };

  const buildPersonShareText = (split: PersonSplit) => {
    const lines: string[] = [];
    lines.push(`${split.person_name} owes ${formatCurrency(split.total)}`);
    lines.push('');
    lines.push('Items:');
    for (const item of split.items as any[]) {
      const qty = typeof item.quantity === 'number' ? item.quantity : 1;
      const name = item.name ?? 'Item';
      const price = formatCurrency(item.total_price ?? 0);
      const splitSuffix = item.isSplit ? ` (${item.splitPercentage?.toFixed(1)}%)` : '';
      lines.push(`- ${qty}x ${name}${splitSuffix}: ${price}`);
    }
    lines.push('');
    lines.push(`Subtotal: ${formatCurrency(split.subtotal)}`);
    lines.push(`Tax: ${formatCurrency(split.tax_share)}`);
    lines.push(`Service charge: ${formatCurrency(split.service_charge_share)}`);
    if (split.discount_share > 0) {
      lines.push(`Discount: -${formatCurrency(split.discount_share)}`);
    }
    lines.push(`Total: ${formatCurrency(split.total)}`);
    return lines.join('\n');
  };

  const buildAllShareText = () => {
    const lines: string[] = [];
    for (const split of personSplits) {
      if (lines.length > 0) lines.push('', '—', '');
      lines.push(buildPersonShareText(split));
    }
    return lines.join('\n');
  };

  const copyTextToClipboard = async (text: string) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  };

  const handleCopyPerson = async (split: PersonSplit) => {
    if (!canExport) return;
    try {
      await copyTextToClipboard(buildPersonShareText(split));
      setCopiedByPersonId((prev) => ({ ...prev, [split.person_id]: true }));
      window.setTimeout(() => {
        setCopiedByPersonId((prev) => ({ ...prev, [split.person_id]: false }));
      }, 1500);
    } catch (e) {
      console.error('Failed to copy split text', e);
    }
  };

  const handleCopyAll = async () => {
    if (!canExport) return;
    setIsCopyingAll(true);
    try {
      await copyTextToClipboard(buildAllShareText());
      setCopiedAll(true);
      window.setTimeout(() => setCopiedAll(false), 1500);
    } catch (e) {
      console.error('Failed to copy all splits text', e);
    } finally {
      setIsCopyingAll(false);
    }
  };

  const handleDownloadPersonPng = async (split: PersonSplit) => {
    if (!canExport) return;
    const node = personCardRefs.current[split.person_id];
    if (!node) return;

    setIsExportingPngByPersonId((prev) => ({ ...prev, [split.person_id]: true }));
    try {
      const dataUrl = await toPng(node, getExportOptionsForNode(node));
      const safeName = split.person_name.trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-');
      downloadFile(dataUrl, `bill-split-${safeName || split.person_id}.png`);
    } catch (e) {
      console.error('Failed to export person split PNG', e);
    } finally {
      setIsExportingPngByPersonId((prev) => ({ ...prev, [split.person_id]: false }));
    }
  };

  const handleDownloadAllPng = async () => {
    if (!canExport) return;
    const node = exportRootRef.current;
    if (!node) return;

    setIsExportingAllPng(true);
    try {
      const dataUrl = await toPng(node, getExportOptionsForNode(node));
      downloadFile(dataUrl, 'bill-split-summary.png');
    } catch (e) {
      console.error('Failed to export full summary PNG', e);
    } finally {
      setIsExportingAllPng(false);
    }
  };

  return (
    <div ref={exportRootRef} className="max-w-4xl mx-auto space-y-5 px-4 sm:px-5">
      <SplitwiseExportWizard
        isOpen={isSplitwiseWizardOpen}
        onClose={() => setIsSplitwiseWizardOpen(false)}
        personSplits={personSplits}
        totalBill={totalBill}
      />
      {/* Header */}
      <Card padding="none" className="overflow-hidden">
        <CardContent className="p-4 md:p-5 flex items-center gap-3 md:gap-4">
          <div className="w-10 h-10 md:w-12 md:h-12 bg-green-100 rounded-full flex items-center justify-center">
            <Calculator className="h-5 w-5 md:h-6 md:w-6 text-green-600" />
          </div>
          <div className="min-w-0">
            <CardTitle className="text-lg md:text-xl leading-tight">Bill split complete</CardTitle>
          </div>
        </CardContent>
      </Card>

      {/* Compact totals widget */}
      <Card padding="none" className="overflow-hidden">
        <CardContent className="p-4 md:p-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Total', value: formatCurrency(totalBill) },
              { label: 'Tax', value: formatCurrency(totalTax) },
              { label: 'Service', value: formatCurrency(totalServiceCharge) },
              { label: 'Discount', value: formatCurrency(totalDiscount) },
            ].map((stat) => (
              <div key={stat.label} className="rounded-lg border border-gray-200 bg-white px-3 py-2 md:px-3.5 md:py-2.5 text-sm">
                <div className="text-xs text-gray-500">{stat.label}</div>
                <div className="text-base md:text-lg font-semibold text-gray-900 mt-1">{stat.value}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Person Splits */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base md:text-lg font-semibold text-gray-900">Individual splits</h3>
          <div className="flex items-center gap-2" data-export-ignore="true">
            <Button
              onClick={handleDownloadAllPng}
              variant="outline"
              size="sm"
              disabled={disabled || isExportingAllPng}
              leftIcon={<Download className="h-3 w-3" />}
            >
              {isExportingAllPng ? 'Downloading...' : 'Download All'}
            </Button>
            <Button
              onClick={handleCopyAll}
              variant="outline"
              size="sm"
              disabled={disabled || isCopyingAll}
              leftIcon={<Copy className="h-3 w-3" />}
            >
              {copiedAll ? 'Copied All' : 'Copy All'}
            </Button>
          </div>
        </div>
        {personSplits.map((split) => (
          <Card key={split.person_id} padding="none" ref={(el: HTMLDivElement | null) => { personCardRefs.current[split.person_id] = el; }}>
            <CardContent className="p-4 md:p-5 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center space-x-3 min-w-0">
                  <div className="w-9 h-9 md:w-10 md:h-10 bg-primary-100 rounded-full flex items-center justify-center shrink-0">
                    <User className="h-5 w-5 text-primary-600" />
                  </div>
                  <div className="min-w-0">
                    <h4 className="text-base md:text-lg font-semibold text-gray-900 truncate">{split.person_name}</h4>
                    <p className="text-xs md:text-sm text-gray-500">
                      {split.items.length} item(s)
                    </p>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xl md:text-2xl font-bold text-gray-900">
                    {formatCurrency(split.total)}
                  </div>
                  <div className="text-xs md:text-sm text-gray-500">Total</div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2" data-export-ignore="true">
                <Button
                  onClick={() => handleDownloadPersonPng(split)}
                  variant="outline"
                  size="sm"
                  disabled={disabled || isExportingPngByPersonId[split.person_id]}
                  leftIcon={<Download className="h-3 w-3" />}
                >
                  {isExportingPngByPersonId[split.person_id] ? 'Downloading...' : 'Download'}
                </Button>
                <Button
                  onClick={() => handleCopyPerson(split)}
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  leftIcon={<Copy className="h-3 w-3" />}
                >
                  {copiedByPersonId[split.person_id] ? 'Copied' : 'Copy'}
                </Button>
              </div>

              {/* Items breakdown */}
              <div className="space-y-1.5">
                <h5 className="text-sm font-medium text-gray-700">Items</h5>
                <div className="space-y-1">
                  {split.items.map((item: any, itemIndex) => (
                    <div key={itemIndex} className="flex justify-between items-center text-sm md:text-base">
                      <span className="text-gray-600 flex items-center gap-2 min-w-0">
                        <span className="truncate">
                          {item.quantity}x {item.name}
                        </span>
                        {item.isSplit && (
                          <span className="inline-flex items-center whitespace-nowrap">
                            <Users className="h-3 w-3 text-blue-500 mr-1" />
                            <span className="text-[11px] text-blue-600">
                              ({item.splitPercentage?.toFixed(1)}%)
                            </span>
                          </span>
                        )}
                      </span>
                      <span className="font-medium shrink-0 text-gray-900">
                        {formatCurrency(item.total_price)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Cost breakdown */}
              <div className="pt-3 border-t border-gray-200">
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-600">Subtotal</span>
                    <span>{formatCurrency(split.subtotal)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Tax</span>
                    <span>{formatCurrency(split.tax_share)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Service</span>
                    <span>{formatCurrency(split.service_charge_share)}</span>
                  </div>
                  {split.discount_share > 0 && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">Discount</span>
                      <span className="text-green-600">-{formatCurrency(split.discount_share)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-semibold text-gray-900 pt-2 border-t border-gray-200">
                    <span>Total</span>
                    <span>{formatCurrency(split.total)}</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Action Buttons */}
      <Card padding="none">
        <CardContent className="p-4 md:p-5" data-export-ignore="true">
          <div className="flex flex-wrap gap-2 md:gap-3 justify-center">
            <Button
              onClick={() => setIsSplitwiseWizardOpen(true)}
              variant="primary"
              disabled={disabled}
              leftIcon={<Send className="h-4 w-4" />}
            >
              Export to Splitwise
            </Button>
            <Button
              onClick={onModifyAssignment}
              variant="secondary"
              disabled={disabled}
              leftIcon={<Users className="h-4 w-4" />}
            >
              Modify Assignment
            </Button>
            <Button
              onClick={onStartOver}
              variant="primary"
              disabled={disabled}
            >
              Split Another Bill
            </Button>
            <Button
              onClick={handlePrint}
              variant="outline"
              disabled={disabled}
              leftIcon={<Receipt className="h-4 w-4" />}
            >
              Print Summary
            </Button>
            <Button
              onClick={onShare}
              disabled={disabled}
              leftIcon={<Share2 className="h-4 w-4" />}
            >
              Share Results
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
