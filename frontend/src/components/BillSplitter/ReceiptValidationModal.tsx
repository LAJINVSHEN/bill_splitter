import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { X, Plus, Trash2, ZoomIn, ZoomOut, CheckCircle, AlertCircle, GripVertical } from 'lucide-react';
import { DndContext, DragOverlay, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/components/UI/Button';

interface BillItem {
  __id?: string;
  name: string;
  quantity: number;
  unit_price: number;
  total_price: number;
}

interface TaxOrCharge {
  name: string;
  amount: number;
  percent?: number;
}

interface StoreInfo {
  name: string;
  address?: string;
  phone?: string;
}

interface ExtractedData {
  items: BillItem[];
  taxes_or_charges: TaxOrCharge[];
  subtotal: number;
  grand_total: number;
  receipt_number: string;
  date: string;
  time: string;
  store: StoreInfo;
  payment_method: string;
  transaction_id?: string;
  notes?: string;
}

type ItemDraft = {
  quantity?: string;
  unit_price?: string;
};

type TaxDraft = {
  percent?: string;
  amount?: string;
  lastEdited?: 'percent' | 'amount';
};

interface ValidationModalProps {
  isOpen: boolean;
  onClose: () => void;
  imageUrl: string;
  extractedData: ExtractedData;
  validationErrors: any;
  onValidate: (editedData: ExtractedData, options?: { auto?: boolean }) => void;
}

export const ReceiptValidationModal: React.FC<ValidationModalProps> = ({
  isOpen,
  onClose,
  imageUrl,
  extractedData,
  validationErrors,
  onValidate,
}) => {
  const [zoom, setZoom] = useState(1);
  const [minZoom, setMinZoom] = useState(0.5);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const editorScrollRef = useRef<HTMLDivElement | null>(null);
  const itemRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const itemNameInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const itemQtyInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const itemUnitInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const taxRowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const taxNameInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const taxPercentInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const taxAmountInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const [lastAddedItemId, setLastAddedItemId] = useState<string | null>(null);
  const [lastAddedTaxIndex, setLastAddedTaxIndex] = useState<number | null>(null);
  const imageContainerRef = useRef<HTMLDivElement | null>(null);
  const didInitViewRef = useRef(false);
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{
    isPinching: boolean;
    startDist: number;
    startZoom: number;
    point: { x: number; y: number };
  }>({
    isPinching: false,
    startDist: 0,
    startZoom: 1,
    point: { x: 0, y: 0 },
  });
  const panRef = useRef<{
    isPanning: boolean;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  }>({
    isPanning: false,
    startX: 0,
    startY: 0,
    panX: 0,
    panY: 0,
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } })
  );

  const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const makeId = () => {
    // Avoid importing deps; good enough for client-side stable keys.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cryptoAny = (globalThis as any).crypto as Crypto | undefined;
    if (cryptoAny?.randomUUID) return cryptoAny.randomUUID();
    return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  };
  const getDistance = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  };
  const getMidpoint = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });

  const clampPan = (candidatePan: { x: number; y: number }, nextZoom: number) => {
    const scaledWidth = imageSize.width * nextZoom;
    const scaledHeight = imageSize.height * nextZoom;

    const maxX = Math.max(0, (scaledWidth - containerSize.width) / 2);
    const maxY = Math.max(0, (scaledHeight - containerSize.height) / 2);

    return {
      x: clamp(candidatePan.x, -maxX, maxX),
      y: clamp(candidatePan.y, -maxY, maxY),
    };
  };

  const normalizeItem = (item: BillItem): BillItem => {
    const quantity = Number.isFinite(item.quantity) ? item.quantity : 0;
    const unit_price = Number.isFinite(item.unit_price) ? item.unit_price : 0;
    return {
      __id: item.__id ?? makeId(),
      ...item,
      quantity,
      unit_price,
      total_price: roundMoney(quantity * unit_price),
    };
  };

  const createEmptyItem = (id?: string): BillItem => ({
    __id: id ?? makeId(),
    name: '',
    quantity: 1,
    unit_price: 0,
    total_price: 0,
  });

  const normalizeTax = (tax: TaxOrCharge): TaxOrCharge => ({
    name: tax.name || '',
    amount: Number.isFinite(tax.amount) ? tax.amount : 0,
    percent: Number.isFinite(tax.percent) ? tax.percent : 0,
  });

  const getTaxAmount = (tax: TaxOrCharge, currentSubtotal: number) => {
    if (tax.percent !== undefined && tax.percent !== null && tax.percent !== 0) {
      return roundMoney(((tax.percent || 0) / 100) * currentSubtotal);
    }
    return roundMoney(tax.amount || 0);
  };

  const [items, setItems] = useState<BillItem[]>(() =>
    (extractedData.items || []).map(normalizeItem)
  );
  const [taxes, setTaxes] = useState<TaxOrCharge[]>(() =>
    (extractedData.taxes_or_charges || []).map(normalizeTax)
  );
  const [activeInsertTarget, setActiveInsertTarget] = useState<string | null>(null);
  const [itemDrafts, setItemDrafts] = useState<Record<string, ItemDraft>>({});
  const [taxDrafts, setTaxDrafts] = useState<Record<number, TaxDraft>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const activeFieldRef = useRef<{ type: 'item' | 'tax'; id: string; field: string } | null>(null);

  if (!isOpen) return null;

  const dataKey = useMemo(
    () =>
      [
        extractedData.receipt_number ?? '',
        extractedData.date ?? '',
        extractedData.time ?? '',
        extractedData.store?.name ?? '',
      ].join('|'),
    [extractedData]
  );
  const hydratedDataKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    // Only hydrate when opening or when a different receipt is loaded.
    if (hydratedDataKeyRef.current === dataKey) return;
    hydratedDataKeyRef.current = dataKey;

    setItems((extractedData.items || []).map(normalizeItem));
    setTaxes((extractedData.taxes_or_charges || []).map(normalizeTax));
    setZoom(1);
    setMinZoom(0.5);
    setPan({ x: 0, y: 0 });
    didInitViewRef.current = false;
    setLastAddedItemId(null);
    setLastAddedTaxIndex(null);
    itemRowRefs.current = {};
    itemNameInputRefs.current = {};
    itemQtyInputRefs.current = {};
    itemUnitInputRefs.current = {};
    setItemDrafts({});
    setTaxDrafts({});
    setFieldErrors({});
    pointersRef.current.clear();
    pinchRef.current.isPinching = false;
    panRef.current.isPanning = false;
    setActiveInsertTarget(null);
  }, [isOpen, dataKey, extractedData]);

  useEffect(() => {
    if (!isOpen) {
      hydratedDataKeyRef.current = null;
    }
  }, [isOpen]);

  useEffect(() => {
    const container = imageContainerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setContainerSize({ width, height });
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    if (didInitViewRef.current) return;
    if (containerSize.width <= 0 || containerSize.height <= 0) return;
    if (imageSize.width <= 0 || imageSize.height <= 0) return;

    const fitZoom = Math.min(
      1,
      containerSize.width / imageSize.width,
      containerSize.height / imageSize.height
    );

    didInitViewRef.current = true;
    setMinZoom(fitZoom);
    setZoom(fitZoom);
    setPan({ x: 0, y: 0 });
  }, [isOpen, containerSize, imageSize]);

  const handleInsertItem = (index: number, position: 'above' | 'below') => {
    const nextId = makeId();
    const newItem = createEmptyItem(nextId);
    setLastAddedItemId(nextId);
    setItems((prev) => {
      const updated = [...prev];
      const targetIndex = position === 'above' ? index : index + 1;
      updated.splice(targetIndex, 0, newItem);
      return updated;
    });
    setActiveInsertTarget(null);
  };

  const handleAddItemToEnd = () => {
    const nextId = makeId();
    setLastAddedItemId(nextId);
    setItems((prev) => [...prev, createEmptyItem(nextId)]);
  };

  const isValidNumericString = (value: string) => /^-?\d*(\.\d*)?$/.test(value.trim());
  const isValidIntegerString = (value: string) => /^\d*$/.test(value.trim());

  const parseNumberInput = (value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    const trimmed = value.trim();
    if (trimmed === '') return 0;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const commitAllDrafts = useCallback(() => {
    const applyItemDrafts = (sourceItems: BillItem[]) => {
      const nextItems = sourceItems.map((item) => {
        const draft = itemDrafts[item.__id ?? ''];
        if (!draft) return item;
        const quantity = draft.quantity !== undefined && draft.quantity.trim() !== ''
          ? parseInt(draft.quantity, 10)
          : item.quantity;
        const unit_price = parseNumberInput(draft.unit_price, item.unit_price);
        return normalizeItem({ ...item, quantity, unit_price });
      });
      return nextItems;
    };

    const applyTaxDrafts = (sourceTaxes: TaxOrCharge[], currentSubtotal: number) => {
      const nextTaxes = sourceTaxes.map((tax, index) => {
        const draft = taxDrafts[index];
        if (!draft) return tax;
        const normalized = normalizeTax(tax);
        const source = draft.lastEdited;

        if (source === 'percent') {
          const percent = parseNumberInput(draft.percent, normalized.percent ?? 0);
          const amount = roundMoney((percent / 100) * currentSubtotal);
          return { ...normalized, percent, amount };
        }

        if (source === 'amount') {
          const amount = parseNumberInput(draft.amount, normalized.amount ?? 0);
          const percent = currentSubtotal > 0 ? roundMoney((amount / currentSubtotal) * 100) : 0;
          return { ...normalized, amount, percent };
        }

        return normalized;
      });

      return nextTaxes;
    };

    const nextItems = applyItemDrafts(items);
    const nextSubtotal = roundMoney(
      nextItems.reduce((sum, item) => sum + (item.total_price || 0), 0)
    );
    const nextTaxes = applyTaxDrafts(taxes, nextSubtotal);
    const nextTaxesTotal = roundMoney(
      nextTaxes.reduce((sum, tax) => sum + getTaxAmount(tax, nextSubtotal), 0)
    );
    const nextGrandTotal = roundMoney(nextSubtotal + nextTaxesTotal);

    setItems(nextItems);
    setTaxes(nextTaxes);
    setItemDrafts({});
    setTaxDrafts({});

    return {
      nextItems,
      nextTaxes,
      nextSubtotal,
      nextGrandTotal,
    };
  }, [items, itemDrafts, taxes, taxDrafts]);

  const handleValidate = useCallback(() => {
    const { nextItems, nextTaxes, nextSubtotal, nextGrandTotal } = commitAllDrafts();

    const editedData: ExtractedData = {
      ...extractedData,
      items: nextItems,
      taxes_or_charges: nextTaxes.map((tax) => ({
        ...tax,
        amount: getTaxAmount(tax, nextSubtotal),
      })),
      subtotal: nextSubtotal,
      grand_total: nextGrandTotal,
    };

    onValidate(editedData);
  }, [commitAllDrafts, extractedData, onValidate]);

  const commitItemDraft = (id: string) => {
    const draft = itemDrafts[id];
    if (!draft) return;

    // Validate numeric strings before commit
    if (draft.quantity !== undefined && draft.quantity !== '' && !isValidNumericString(draft.quantity)) {
      setFieldErrors((prev) => ({ ...prev, [`item-${id}-quantity`]: 'Enter a number' }));
      return;
    }
    if (draft.unit_price !== undefined && draft.unit_price !== '' && !isValidNumericString(draft.unit_price)) {
      setFieldErrors((prev) => ({ ...prev, [`item-${id}-unit_price`]: 'Enter a number' }));
      return;
    }

    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[`item-${id}-quantity`];
      delete next[`item-${id}-unit_price`];
      return next;
    });

    setItems((prev) => {
      const updated = prev.map((item) => {
        const currentId = item.__id ?? '';
        if (currentId !== id) return item;

        const quantity = draft.quantity !== undefined && draft.quantity.trim() !== ''
          ? parseInt(draft.quantity, 10)
          : item.quantity;
        const unit_price = parseNumberInput(draft.unit_price, item.unit_price);
        return normalizeItem({ ...item, quantity, unit_price });
      });
      return updated;
    });

    setItemDrafts((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const handleDeleteItem = (index: number) => {
    const targetId = items[index]?.__id;
    if (targetId && activeInsertTarget === targetId) {
      setActiveInsertTarget(null);
    }
    setItems(items.filter((_, i) => i !== index));
    if (targetId) {
      setItemDrafts((prev) => {
        if (!prev[targetId]) return prev;
        const next = { ...prev };
        delete next[targetId];
        return next;
      });
    }
  };

  const handleItemNameChange = (index: number, value: string) => {
    setItems((prev) => {
      const updated = [...prev];
      if (!updated[index]) return prev;
      updated[index] = { ...updated[index], name: value };
      return updated;
    });
    const id = items[index]?.__id ?? '';
    activeFieldRef.current = { type: 'item', id, field: 'name' };
  };

  const handleItemNumericInputChange = (itemId: string, field: keyof ItemDraft, value: string) => {
    const isQuantity = field === 'quantity';
    const valid = isQuantity ? isValidIntegerString(value) : isValidNumericString(value);
    if (value !== '' && !valid) {
      setFieldErrors((prev) => ({
        ...prev,
        [`item-${itemId}-${field}`]: isQuantity ? 'Enter a whole number' : 'Enter a number',
      }));
      return;
    }

    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[`item-${itemId}-${field}`];
      return next;
    });

    activeFieldRef.current = { type: 'item', id: itemId, field };
    setItemDrafts((prev) => ({
      ...prev,
      [itemId]: {
        ...prev[itemId],
        [field]: value,
      },
    }));
  };

  const getItemInputValue = (item: BillItem, field: keyof ItemDraft) => {
    const draft = itemDrafts[item.__id ?? ''];
    const draftValue = draft?.[field];
    if (draftValue !== undefined) return draftValue;

    const raw = field === 'quantity' ? item.quantity : item.unit_price;
    return raw === 0 ? '' : String(raw ?? '');
  };

  const handleTaxNameChange = (index: number, name: string) => {
    setTaxes((prev) => {
      const updated = [...prev];
      const current = updated[index] ?? { name: '', amount: 0, percent: 0 };
      updated[index] = { ...current, name };
      return updated;
    });
    activeFieldRef.current = { type: 'tax', id: String(index), field: 'name' };
  };

  const handleTaxPercentInputChange = (index: number, value: string) => {
    if (value !== '' && !isValidNumericString(value)) {
      setFieldErrors((prev) => ({ ...prev, [`tax-${index}-percent`]: 'Enter a number' }));
      return;
    }
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[`tax-${index}-percent`];
      return next;
    });
    activeFieldRef.current = { type: 'tax', id: String(index), field: 'percent' };
    setTaxDrafts((prev) => ({
      ...prev,
      [index]: { ...prev[index], percent: value, lastEdited: 'percent' },
    }));
  };

  const handleTaxAmountInputChange = (index: number, value: string) => {
    if (value !== '' && !isValidNumericString(value)) {
      setFieldErrors((prev) => ({ ...prev, [`tax-${index}-amount`]: 'Enter a number' }));
      return;
    }
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[`tax-${index}-amount`];
      return next;
    });
    activeFieldRef.current = { type: 'tax', id: String(index), field: 'amount' };
    setTaxDrafts((prev) => ({
      ...prev,
      [index]: { ...prev[index], amount: value, lastEdited: 'amount' },
    }));
  };

  const getTaxInputValue = (index: number, field: keyof Pick<TaxDraft, 'amount' | 'percent'>, fallback: number) => {
    const draft = taxDrafts[index];
    const draftValue = draft?.[field];
    if (draftValue !== undefined) return draftValue;
    return fallback === 0 ? '' : String(fallback);
  };

  const commitTaxDraft = (index: number, source: 'percent' | 'amount') => {
    const draft = taxDrafts[index];
    if (!draft) return;

    const percentKey = `tax-${index}-percent`;
    const amountKey = `tax-${index}-amount`;

    if (draft.percent !== undefined && draft.percent !== '' && !isValidNumericString(draft.percent)) {
      setFieldErrors((prev) => ({ ...prev, [percentKey]: 'Enter a number' }));
      return;
    }
    if (draft.amount !== undefined && draft.amount !== '' && !isValidNumericString(draft.amount)) {
      setFieldErrors((prev) => ({ ...prev, [amountKey]: 'Enter a number' }));
      return;
    }

    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[percentKey];
      delete next[amountKey];
      return next;
    });

    setTaxes((prev) => {
      const updated = [...prev];
      const current = normalizeTax(updated[index] ?? { name: '', amount: 0, percent: 0 });

      if (source === 'percent') {
        const percent = parseNumberInput(draft.percent, current.percent ?? 0);
        const amount = roundMoney((percent / 100) * subtotal);
        updated[index] = { ...current, percent, amount };
      } else {
        const amount = parseNumberInput(draft.amount, current.amount ?? 0);
        const percent = subtotal > 0 ? roundMoney((amount / subtotal) * 100) : 0;
        updated[index] = { ...current, amount, percent };
      }

      return updated;
    });

    setTaxDrafts((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  };

  const handleAddTax = () => {
    setTaxes((prev) => {
      const nextIndex = prev.length;
      setLastAddedTaxIndex(nextIndex);
      return [...prev, { name: '', amount: 0, percent: 0 }];
    });
  };

  useEffect(() => {
    if (!isOpen) return;
    if (!lastAddedItemId) return;
    const row = itemRowRefs.current[lastAddedItemId];
    if (!row) return;

    requestAnimationFrame(() => {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const input = itemNameInputRefs.current[lastAddedItemId];
      input?.focus();
      setLastAddedItemId(null);
    });
  }, [isOpen, lastAddedItemId, items.length]);

  useEffect(() => {
    if (!isOpen) return;
    if (lastAddedTaxIndex === null) return;
    const row = taxRowRefs.current[lastAddedTaxIndex];
    if (!row) return;

    requestAnimationFrame(() => {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const input = taxNameInputRefs.current[lastAddedTaxIndex];
      input?.focus();
      setLastAddedTaxIndex(null);
    });
  }, [isOpen, lastAddedTaxIndex, taxes.length]);

  useEffect(() => {
    if (!activeInsertTarget) return;
    const handleOutsideClick = (event: PointerEvent) => {
      const activeRow = itemRowRefs.current[activeInsertTarget];
      if (!activeRow) {
        setActiveInsertTarget(null);
        return;
      }
      if (event.target instanceof Node && activeRow.contains(event.target)) {
        return;
      }
      setActiveInsertTarget(null);
    };

    document.addEventListener('pointerdown', handleOutsideClick);
    return () => document.removeEventListener('pointerdown', handleOutsideClick);
  }, [activeInsertTarget]);

  useEffect(() => {
    if (!activeInsertTarget) return;
    if (!items.some((item) => item.__id === activeInsertTarget)) {
      setActiveInsertTarget(null);
    }
  }, [items, activeInsertTarget]);

  useLayoutEffect(() => {
    const active = activeFieldRef.current;
    if (!active) return;

    const focusTarget = (() => {
      if (active.type === 'item') {
        if (active.field === 'name') return itemNameInputRefs.current[active.id] || null;
        if (active.field === 'quantity') return itemQtyInputRefs.current[active.id] || null;
        if (active.field === 'unit_price') return itemUnitInputRefs.current[active.id] || null;
      }
      if (active.type === 'tax') {
        const idx = Number(active.id);
        if (active.field === 'name') return taxNameInputRefs.current[idx] || null;
        if (active.field === 'percent') return taxPercentInputRefs.current[idx] || null;
        if (active.field === 'amount') return taxAmountInputRefs.current[idx] || null;
      }
      return null;
    })();

    if (focusTarget && document.activeElement !== focusTarget) {
      focusTarget.focus();
      const len = focusTarget.value?.length ?? 0;
      try {
        focusTarget.setSelectionRange(len, len);
      } catch {
        /* ignore */
      }
    }
  }, [items, taxes, itemDrafts, taxDrafts]);

  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const activeDragItem = useMemo(() => {
    if (!activeDragId) return null;
    return items.find((item) => item.__id === activeDragId) ?? null;
  }, [activeDragId, items]);

  const handleDragEnd = (event: { active: { id: any }; over: { id: any } | null }) => {
    const { active, over } = event;
    setActiveDragId(null);
    if (!over) return;
    if (active.id === over.id) return;

    setItems((prev) => {
      const oldIndex = prev.findIndex((item) => item.__id === active.id);
      const newIndex = prev.findIndex((item) => item.__id === over.id);
      if (oldIndex < 0 || newIndex < 0) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  };

  const toggleInsertMenu = (id: string) => {
    setActiveInsertTarget((prev) => (prev === id ? null : id));
  };

  const SortableItemRow: React.FC<{
    item: BillItem;
    index: number;
    isInsertMenuOpen: boolean;
    onToggleInsertMenu: (id: string) => void;
    onInsert: (index: number, position: 'above' | 'below') => void;
  }> = ({ item, index, isInsertMenuOpen, onToggleInsertMenu, onInsert }) => {
    const id = item.__id ?? `${index}`;
    const {
      attributes,
      listeners,
      setNodeRef,
      setActivatorNodeRef,
      transform,
      transition,
      isDragging,
    } = useSortable({ id });

    const style: React.CSSProperties = {
      transform: CSS.Transform.toString(transform),
      transition,
      zIndex: isDragging ? 20 : undefined,
    };

    return (
      <div
        ref={(el) => {
          setNodeRef(el);
          if (id) itemRowRefs.current[id] = el;
        }}
        style={style}
        className={[
          'relative flex items-start gap-2 md:gap-3 p-2.5 md:p-3 pb-8 md:pb-6 pr-4 md:pr-5 bg-white border border-gray-200 rounded-md transition-shadow',
          isDragging ? 'shadow-md ring-2 ring-primary-200' : 'hover:shadow-sm',
        ].join(' ')}
      >
        <div className="flex items-stretch">
          <button
            ref={setActivatorNodeRef}
            type="button"
            className="flex h-full min-h-[44px] w-9 items-center justify-center rounded-md border border-gray-200 bg-gray-50 text-gray-400 hover:text-gray-700 hover:border-gray-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 cursor-grab active:cursor-grabbing"
            style={{ touchAction: 'none' }}
            aria-label="Reorder item"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-12 gap-2 flex-1 min-w-0">
          <input
            type="text"
            value={item.name}
            onChange={(e) => handleItemNameChange(index, e.target.value)}
            placeholder="Item name"
            onFocus={() => {
              if (item.__id) activeFieldRef.current = { type: 'item', id: item.__id, field: 'name' };
            }}
            ref={(el) => {
              if (item.__id) itemNameInputRefs.current[item.__id] = el;
            }}
            className="col-span-12 md:col-span-6 h-9 md:h-9 px-2 py-1.5 border rounded-md text-sm bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          />
          <input
            type="text"
            inputMode="decimal"
            value={getItemInputValue(item, 'quantity')}
            onChange={(e) => handleItemNumericInputChange(id, 'quantity', e.target.value)}
            onBlur={() => commitItemDraft(id)}
            placeholder="Qty"
            onFocus={(e) => {
              e.target.select();
              if (item.__id) activeFieldRef.current = { type: 'item', id: item.__id, field: 'quantity' };
            }}
            ref={(el) => {
              if (item.__id) itemQtyInputRefs.current[item.__id] = el;
            }}
            className={[
              'col-span-4 md:col-span-2 h-9 self-center px-2 py-1.5 border rounded-md text-sm text-right bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500',
              fieldErrors[`item-${id}-quantity`] ? 'border-red-400 focus:ring-red-400 focus:border-red-400' : ''
            ].join(' ')}
            aria-invalid={Boolean(fieldErrors[`item-${id}-quantity`])}
            aria-describedby={fieldErrors[`item-${id}-quantity`] ? `item-${id}-quantity-error` : undefined}
          />
          <input
            type="text"
            inputMode="decimal"
            value={getItemInputValue(item, 'unit_price')}
            onChange={(e) => handleItemNumericInputChange(id, 'unit_price', e.target.value)}
            onBlur={() => commitItemDraft(id)}
            placeholder="Unit"
            onFocus={(e) => {
              e.target.select();
              if (item.__id) activeFieldRef.current = { type: 'item', id: item.__id, field: 'unit_price' };
            }}
            ref={(el) => {
              if (item.__id) itemUnitInputRefs.current[item.__id] = el;
            }}
            className={[
              'col-span-4 md:col-span-2 h-9 self-center px-2 py-1.5 border rounded-md text-sm text-right bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [-moz-appearance:textfield]',
              fieldErrors[`item-${id}-unit_price`] ? 'border-red-400 focus:ring-red-400 focus:border-red-400' : ''
            ].join(' ')}
            aria-invalid={Boolean(fieldErrors[`item-${id}-unit_price`])}
            aria-describedby={fieldErrors[`item-${id}-unit_price`] ? `item-${id}-unit_price-error` : undefined}
          />
          <input
            type="number"
            step="0.01"
            value={item.total_price}
            readOnly
            tabIndex={-1}
            aria-readonly="true"
            className="col-span-4 md:col-span-2 h-9 self-center px-2 py-1.5 border rounded-md text-sm text-right bg-gray-100 text-gray-700 appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [-moz-appearance:textfield]"
          />
        </div>

        <div className="flex items-start pt-0.5">
          <button
            onClick={() => handleDeleteItem(index)}
            className="p-2 text-red-500 hover:bg-red-50 rounded-md"
            type="button"
            aria-label="Delete item"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>

        <div className="absolute bottom-2 right-2 flex items-center justify-end">
          {isInsertMenuOpen && (
            <div className="absolute bottom-10 right-0 z-30 w-36 rounded-md border border-gray-200 bg-white shadow-lg p-1.5">
              <button
                type="button"
                className="w-full text-left px-2.5 py-1.5 text-xs font-medium text-gray-700 rounded hover:bg-primary-50"
                onClick={() => onInsert(index, 'above')}
              >
                Insert above
              </button>
              <button
                type="button"
                className="w-full text-left px-2.5 py-1.5 text-xs font-medium text-gray-700 rounded hover:bg-primary-50"
                onClick={() => onInsert(index, 'below')}
              >
                Insert below
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={() => onToggleInsertMenu(id)}
            className="relative z-10 h-8 w-8 flex items-center justify-center rounded-full border border-primary-200 bg-primary-50 text-primary-600 hover:bg-primary-100 shadow-sm"
            aria-label="Add item near this row"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  };

  const handleDeleteTax = (index: number) => {
    setTaxes(prev => prev.filter((_, i) => i !== index));
    setTaxDrafts((prev) => {
      if (!prev[index]) return prev;
      const next: Record<number, TaxDraft> = {};
      Object.entries(prev).forEach(([key, value]) => {
        const idx = Number(key);
        if (idx < index) next[idx] = value;
        if (idx > index) next[idx - 1] = value;
      });
      return next;
    });
  };

  const subtotal = useMemo(() => roundMoney(items.reduce((sum, item) => sum + (item.total_price || 0), 0)), [items]);
  const taxesAndChargesTotal = useMemo(() => {
    const total = taxes.reduce((sum, tax) => sum + getTaxAmount(tax, subtotal), 0);
    return roundMoney(total);
  }, [taxes, subtotal]);
  const total = useMemo(() => roundMoney(subtotal + taxesAndChargesTotal), [subtotal, taxesAndChargesTotal]);

  // Extract error message
  const getErrorMessage = () => {
    if (!validationErrors) return null;
    
    if (typeof validationErrors === 'string') {
      return validationErrors;
    }
    
    if (validationErrors.message) {
      return validationErrors.message;
    }
    
    if (validationErrors.detail) {
      if (typeof validationErrors.detail === 'string') {
        return validationErrors.detail;
      }
      if (validationErrors.detail.message) {
        return validationErrors.detail.message;
      }
    }
    
    return JSON.stringify(validationErrors);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-0 md:p-4">
      <div className="bg-white rounded-none md:rounded-lg w-full max-w-none md:max-w-6xl h-screen supports-[height:100dvh]:h-[100dvh] md:h-auto md:max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="shrink-0 px-3 py-2 md:px-6 md:py-4 border-b flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-base md:text-xl font-semibold leading-tight">Review & Edit Receipt</h2>
            {/* Validation Status Indicator */}
            {validationErrors ? (
              <div className="flex items-center gap-1.5 px-2 py-0.5 md:gap-2 md:px-3 md:py-1 bg-red-50 border border-red-200 rounded-full">
                <AlertCircle className="h-4 w-4 text-red-500" />
                <span className="text-xs md:text-sm text-red-700 font-medium">Validation Failed</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 px-2 py-0.5 md:gap-2 md:px-3 md:py-1 bg-green-50 border border-green-200 rounded-full">
                <CheckCircle className="h-4 w-4 text-green-500" />
                <span className="text-xs md:text-sm text-green-700 font-medium">Validation Passed</span>
              </div>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Error Display */}
        {validationErrors && (
          <div className="hidden md:block mx-6 mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <AlertCircle className="h-5 w-5 text-red-500" />
              <p className="text-sm text-red-700 font-medium">Validation Issues Found:</p>
            </div>
            <p className="text-sm text-red-600">{getErrorMessage()}</p>
            <p className="text-xs text-red-500 mt-2">Please review and correct the extracted data below before proceeding.</p>
          </div>
        )}

        {/* Success Display */}
        {!validationErrors && (
          <div className="hidden md:block mx-6 mt-4 p-4 bg-green-50 border border-green-200 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle className="h-5 w-5 text-green-500" />
              <p className="text-sm text-green-700 font-medium">Receipt Data Extracted Successfully!</p>
            </div>
            <p className="text-sm text-green-600">The receipt data has been automatically extracted and validated. Please review the details below and make any necessary adjustments before proceeding.</p>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col md:flex-row">
          {/* Left Panel - Image Preview */}
          <div className="w-full md:w-1/2 min-h-0 border-b md:border-b-0 md:border-r p-3 md:p-4 flex flex-col flex-[2] md:flex-1">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-700">Receipt Image</span>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const next = clamp(zoom - 0.25, minZoom, 3);
                    setZoom(next);
                    setPan(prev => clampPan(prev, next));
                  }}
                  className="p-1 hover:bg-gray-100 rounded"
                  type="button"
                >
                  <ZoomOut className="h-4 w-4" />
                </button>
                <button
                  onClick={() => {
                    const next = clamp(zoom + 0.25, minZoom, 3);
                    setZoom(next);
                    setPan(prev => clampPan(prev, next));
                  }}
                  className="p-1 hover:bg-gray-100 rounded"
                  type="button"
                >
                  <ZoomIn className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div
              ref={imageContainerRef}
              className="w-full aspect-square md:aspect-auto md:flex-1 min-h-0 overflow-hidden bg-gray-50 rounded cursor-grab active:cursor-grabbing select-none"
              style={{ overscrollBehavior: 'contain', touchAction: 'none' }}
              onWheel={(e) => {
                e.preventDefault();
                const container = imageContainerRef.current;
                if (!container) return;
                if (containerSize.width <= 0 || containerSize.height <= 0) return;

                const rect = container.getBoundingClientRect();
                const cursorX = e.clientX - rect.left;
                const cursorY = e.clientY - rect.top;
                const cursorOffsetX = cursorX - containerSize.width / 2;
                const cursorOffsetY = cursorY - containerSize.height / 2;

                const nextZoom = clamp(zoom + (e.deltaY < 0 ? 0.15 : -0.15), minZoom, 3);

                // Keep the point under the cursor stable when zooming
                const pointX = (cursorOffsetX - pan.x) / zoom;
                const pointY = (cursorOffsetY - pan.y) / zoom;
                const nextPan = {
                  x: cursorOffsetX - nextZoom * pointX,
                  y: cursorOffsetY - nextZoom * pointY,
                };

                setZoom(nextZoom);
                setPan(clampPan(nextPan, nextZoom));
              }}
              onPointerDown={(e) => {
                if (e.pointerType === 'mouse' && e.button !== 0) return;
                (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

                // If we have 2 pointers, start pinch zoom.
                if (pointersRef.current.size === 2) {
                  const container = imageContainerRef.current;
                  if (!container) return;
                  if (containerSize.width <= 0 || containerSize.height <= 0) return;

                  const points = Array.from(pointersRef.current.values());
                  const p0 = points[0];
                  const p1 = points[1];
                  if (!p0 || !p1) return;

                  const rect = container.getBoundingClientRect();
                  const mid = getMidpoint(p0, p1);
                  const cursorX = mid.x - rect.left;
                  const cursorY = mid.y - rect.top;
                  const cursorOffsetX = cursorX - containerSize.width / 2;
                  const cursorOffsetY = cursorY - containerSize.height / 2;

                  pinchRef.current.isPinching = true;
                  pinchRef.current.startDist = Math.max(1, getDistance(p0, p1));
                  pinchRef.current.startZoom = zoom;
                  pinchRef.current.point = {
                    x: (cursorOffsetX - pan.x) / zoom,
                    y: (cursorOffsetY - pan.y) / zoom,
                  };

                  panRef.current.isPanning = false;
                  return;
                }

                panRef.current.isPanning = true;
                panRef.current.startX = e.clientX;
                panRef.current.startY = e.clientY;
                panRef.current.panX = pan.x;
                panRef.current.panY = pan.y;
              }}
              onPointerMove={(e) => {
                if (pointersRef.current.has(e.pointerId)) {
                  pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
                }

                if (pinchRef.current.isPinching && pointersRef.current.size >= 2) {
                  const container = imageContainerRef.current;
                  if (!container) return;
                  if (containerSize.width <= 0 || containerSize.height <= 0) return;

                  const points = Array.from(pointersRef.current.values());
                  const p0 = points[0];
                  const p1 = points[1];
                  if (!p0 || !p1) return;

                  const rect = container.getBoundingClientRect();
                  const mid = getMidpoint(p0, p1);
                  const cursorX = mid.x - rect.left;
                  const cursorY = mid.y - rect.top;
                  const cursorOffsetX = cursorX - containerSize.width / 2;
                  const cursorOffsetY = cursorY - containerSize.height / 2;

                  const currentDist = Math.max(1, getDistance(p0, p1));
                  const scale = currentDist / Math.max(1, pinchRef.current.startDist);
                  const nextZoom = clamp(pinchRef.current.startZoom * scale, minZoom, 3);
                  const nextPan = {
                    x: cursorOffsetX - nextZoom * pinchRef.current.point.x,
                    y: cursorOffsetY - nextZoom * pinchRef.current.point.y,
                  };

                  setZoom(nextZoom);
                  setPan(clampPan(nextPan, nextZoom));
                  return;
                }

                if (!panRef.current.isPanning) return;
                const dx = e.clientX - panRef.current.startX;
                const dy = e.clientY - panRef.current.startY;
                const candidate = { x: panRef.current.panX + dx, y: panRef.current.panY + dy };
                setPan(clampPan(candidate, zoom));
              }}
              onPointerUp={(e) => {
                pointersRef.current.delete(e.pointerId);
                if (pointersRef.current.size < 2) {
                  pinchRef.current.isPinching = false;
                }
                panRef.current.isPanning = false;
              }}
              onPointerCancel={(e) => {
                pointersRef.current.delete(e.pointerId);
                if (pointersRef.current.size < 2) {
                  pinchRef.current.isPinching = false;
                }
                panRef.current.isPanning = false;
              }}
            >
              <div className="w-full h-full flex items-center justify-center">
                <img
                  src={imageUrl}
                  alt="Receipt"
                  onLoad={(e) => {
                    const img = e.currentTarget;
                    setImageSize({ width: img.naturalWidth, height: img.naturalHeight });
                  }}
                  style={{
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                    transformOrigin: 'center center',
                  }}
                  className="max-w-none max-h-none"
                  draggable={false}
                />
              </div>
            </div>
          </div>

          {/* Right Panel - Editable Fields */}
          <div ref={editorScrollRef} className="w-full md:w-1/2 min-h-0 p-4 md:p-5 overflow-y-auto bg-gradient-to-b from-gray-50 via-white to-white flex-[3] md:flex-1">
            {/* Items Section */}
            <div className="mb-7">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <h3 className="font-semibold text-gray-900">Items</h3>
                  <p className="text-xs text-gray-500 mt-0.5">Tap the + on any item to insert a new one above or below.</p>
                </div>
              </div>
              <div className="hidden md:grid grid-cols-12 gap-2 px-2 py-2 mb-2 text-[10px] uppercase tracking-wide text-gray-500 bg-white border border-gray-200 rounded-md">
                <div className="col-span-6">Item</div>
                <div className="col-span-2 text-right">Qty</div>
                <div className="col-span-2 text-right">Unit</div>
                <div className="col-span-2 text-right">Total</div>
              </div>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={(e) => setActiveDragId(String(e.active.id))}
                onDragCancel={() => setActiveDragId(null)}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={items.map((item, index) => item.__id ?? `missing-${index}`)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-2">
                    {items.map((item, index) => {
                      const rowId = item.__id ?? `missing-${index}`;
                      return (
                        <SortableItemRow
                          key={rowId}
                          item={item}
                          index={index}
                          isInsertMenuOpen={activeInsertTarget === rowId}
                          onToggleInsertMenu={toggleInsertMenu}
                          onInsert={handleInsertItem}
                        />
                      );
                    })}
                  </div>
                </SortableContext>

                {items.length === 0 && (
                  <div className="mt-3 rounded-md border border-dashed border-gray-300 bg-white p-3 text-center text-sm text-gray-600">
                    <p className="mb-2">No items yet. Add your first item to start.</p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleAddItemToEnd}
                      type="button"
                      className="text-xs md:text-sm px-2.5"
                    >
                      <Plus className="h-4 w-4 mr-1" /> Add first item
                    </Button>
                  </div>
                )}

                <DragOverlay>
                  {activeDragItem ? (
                    <div className="bg-white border border-gray-200 rounded-md p-2 shadow-xl">
                      <div className="flex items-center gap-2">
                        <GripVertical className="h-4 w-4 text-gray-400" />
                        <div className="text-sm font-medium text-gray-900 truncate max-w-[16rem]">
                          {activeDragItem.name || 'New item'}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
            </div>

            {/* Taxes Section */}
            <div className="mb-7 pb-7 border-b">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h3 className="font-semibold text-gray-900">Taxes & Charges</h3>
                  <p className="text-xs text-gray-500">Add percentage or flat amounts. We will keep totals in sync.</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleAddTax}
                  type="button"
                  className="text-xs md:text-sm px-2.5 md:px-3"
                >
                  <Plus className="h-4 w-4 mr-1" /> Add Tax/Charge
                </Button>
              </div>
              <div className="space-y-2">
                {taxes.map((tax, index) => {
                  const calculatedAmount = getTaxAmount(tax, subtotal);
                  const percentDisplay = getTaxInputValue(index, 'percent', tax.percent || 0);
                  const amountDisplay = getTaxInputValue(index, 'amount', calculatedAmount);

                  return (
                    <div
                      key={index}
                      ref={(el) => { taxRowRefs.current[index] = el; }}
                      className="grid grid-cols-12 gap-2 md:gap-3 items-center rounded-lg border border-gray-200 bg-white/80 p-3 shadow-sm"
                    >
                      <input
                        type="text"
                        value={tax.name}
                        onChange={(e) => handleTaxNameChange(index, e.target.value)}
                        onFocus={() => { activeFieldRef.current = { type: 'tax', id: String(index), field: 'name' }; }}
                        placeholder="Tax/Charge name"
                        ref={(el) => { taxNameInputRefs.current[index] = el; }}
                        className="col-span-5 md:col-span-6 h-10 px-3 py-2 border rounded-md text-xs md:text-sm bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 min-w-0"
                        aria-invalid={Boolean(fieldErrors[`tax-${index}-name`])}
                        aria-describedby={fieldErrors[`tax-${index}-name`] ? `tax-${index}-name-error` : undefined}
                      />
                      <div className="col-span-3 md:col-span-3">
                        <div className="relative">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={percentDisplay}
                        onChange={(e) => handleTaxPercentInputChange(index, e.target.value)}
                        onBlur={() => commitTaxDraft(index, 'percent')}
                        placeholder="%"
                        onFocus={(e) => {
                          e.target.select();
                          activeFieldRef.current = { type: 'tax', id: String(index), field: 'percent' };
                        }}
                        ref={(el) => { taxPercentInputRefs.current[index] = el; }}
                        className={[
                          'w-full h-10 px-3 py-2 pr-9 border rounded-md text-xs md:text-sm text-right bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [-moz-appearance:textfield]',
                          fieldErrors[`tax-${index}-percent`] ? 'border-red-400 focus:ring-red-400 focus:border-red-400' : ''
                        ].join(' ')}
                        aria-invalid={Boolean(fieldErrors[`tax-${index}-percent`])}
                            aria-describedby={fieldErrors[`tax-${index}-percent`] ? `tax-${index}-percent-error` : undefined}
                            />
                          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11px] md:text-xs text-gray-500">%</span>
                        </div>
                      </div>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={amountDisplay}
                        onChange={(e) => handleTaxAmountInputChange(index, e.target.value)}
                        onBlur={() => commitTaxDraft(index, 'amount')}
                        placeholder="Amount"
                        onFocus={(e) => {
                          e.target.select();
                          activeFieldRef.current = { type: 'tax', id: String(index), field: 'amount' };
                        }}
                        ref={(el) => { taxAmountInputRefs.current[index] = el; }}
                        className={[
                          'col-span-3 md:col-span-3 h-10 px-3 py-2 border rounded-md text-xs md:text-sm text-right bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [-moz-appearance:textfield]',
                          fieldErrors[`tax-${index}-amount`] ? 'border-red-400 focus:ring-red-400 focus:border-red-400' : ''
                        ].join(' ')}
                        aria-invalid={Boolean(fieldErrors[`tax-${index}-amount`])}
                        aria-describedby={fieldErrors[`tax-${index}-amount`] ? `tax-${index}-amount-error` : undefined}
                      />
                      <div className="col-span-1 flex justify-end h-full">
                        <button
                          onClick={() => handleDeleteTax(index)}
                          className="p-2 text-red-500 hover:bg-red-50 rounded-md"
                          type="button"
                          aria-label="Delete tax or charge"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Totals Section */}
            <div className="space-y-3">
              <h3 className="font-semibold text-gray-900">Totals</h3>
              <div className="rounded-xl border border-primary-100 bg-primary-50/80 p-4 space-y-2">
                <div className="flex justify-between text-sm text-gray-700">
                  <span>Subtotal</span>
                  <span className="font-medium text-gray-900">{subtotal.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm text-gray-700">
                  <span>Taxes & charges</span>
                  <span className="font-medium text-gray-900">{taxesAndChargesTotal.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center pt-2 border-t border-primary-100">
                  <span className="text-sm font-semibold text-primary-900">Grand total</span>
                  <div className="px-3 py-2 rounded-md text-sm font-semibold text-primary-900 bg-white shadow-inner min-w-[6rem] text-right">
                    {total.toFixed(2)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 px-4 py-3 md:px-6 md:py-4 border-t flex justify-end gap-3">
          <Button className="md:hidden" size="sm" variant="outline" onClick={onClose} type="button">Cancel</Button>
          <Button className="hidden md:inline-flex" variant="outline" onClick={onClose} type="button">Cancel</Button>
          <Button className="md:hidden" size="sm" onClick={() => handleValidate()} type="button">
            {validationErrors ? 'Fix & Validate' : 'Confirm & Continue'}
          </Button>
          <Button className="hidden md:inline-flex" onClick={() => handleValidate()} type="button">
            {validationErrors ? 'Fix & Validate' : 'Confirm & Continue'}
          </Button>
        </div>
      </div>
    </div>
  );
};
