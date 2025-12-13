import React, { useEffect, useMemo, useRef, useState } from 'react';
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

interface ValidationModalProps {
  isOpen: boolean;
  onClose: () => void;
  imageUrl: string;
  extractedData: ExtractedData;
  validationErrors: any;
  onValidate: (editedData: ExtractedData) => void;
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
  const taxRowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const taxNameInputRefs = useRef<Array<HTMLInputElement | null>>([]);
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

  const [items, setItems] = useState<BillItem[]>(() =>
    (extractedData.items || []).map(normalizeItem)
  );
  const [taxes, setTaxes] = useState<TaxOrCharge[]>(() => extractedData.taxes_or_charges || []);

  if (!isOpen) return null;

  useEffect(() => {
    if (!isOpen) return;
    setItems((extractedData.items || []).map(normalizeItem));
    setTaxes(extractedData.taxes_or_charges || []);
    setZoom(1);
    setMinZoom(0.5);
    setPan({ x: 0, y: 0 });
    didInitViewRef.current = false;
    setLastAddedItemId(null);
    setLastAddedTaxIndex(null);
    itemRowRefs.current = {};
    itemNameInputRefs.current = {};
    pointersRef.current.clear();
    pinchRef.current.isPinching = false;
    panRef.current.isPanning = false;
  }, [isOpen, extractedData]);

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

  const handleAddItem = () => {
    setItems((prev) => {
      const nextId = makeId();
      setLastAddedItemId(nextId);
      return [...prev, { __id: nextId, name: '', quantity: 1, unit_price: 0, total_price: 0 }];
    });
  };

  const handleDeleteItem = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
  };

  const handleItemChange = (index: number, field: keyof BillItem, value: any) => {
    if (field === 'total_price') return; // computed

    setItems(prev => {
      const updated = [...prev];
      const current = updated[index];
      if (!current) return prev;

      const next: BillItem = { ...current, [field]: value };
      if (field === 'quantity' || field === 'unit_price') {
        const quantity = Number.isFinite(next.quantity) ? next.quantity : 0;
        const unit_price = Number.isFinite(next.unit_price) ? next.unit_price : 0;
        next.total_price = roundMoney(quantity * unit_price);
      }

      updated[index] = next;
      return updated;
    });
  };

  const handleTaxChange = (index: number, field: keyof TaxOrCharge, value: any) => {
    const updated = [...taxes];
    updated[index] = { ...updated[index], [field]: value };
    setTaxes(updated);
  };

  const handleAddTax = () => {
    setTaxes((prev) => {
      const nextIndex = prev.length;
      setLastAddedTaxIndex(nextIndex);
      return [...prev, { name: '', amount: 0 }];
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

  const SortableItemRow: React.FC<{
    item: BillItem;
    index: number;
  }> = ({ item, index }) => {
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
          if (item.__id) itemRowRefs.current[item.__id] = el;
        }}
        style={style}
        className={[
          'flex items-start gap-2 md:gap-3 p-2.5 md:p-3 bg-white border border-gray-200 rounded-md transition-shadow',
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
            onChange={(e) => handleItemChange(index, 'name', e.target.value)}
            placeholder="Item name"
            ref={(el) => {
              if (item.__id) itemNameInputRefs.current[item.__id] = el;
            }}
            className="col-span-12 md:col-span-6 h-9 md:h-9 px-2 py-1.5 border rounded-md text-sm bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          />
          <input
            type="number"
            value={item.quantity}
            onChange={(e) => handleItemChange(index, 'quantity', parseInt(e.target.value) || 0)}
            placeholder="Qty"
            className="col-span-4 md:col-span-2 h-9 self-center px-2 py-1.5 border rounded-md text-sm text-right bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          />
          <input
            type="number"
            step="0.01"
            value={item.unit_price}
            onChange={(e) => handleItemChange(index, 'unit_price', parseFloat(e.target.value) || 0)}
            placeholder="Unit"
            className="col-span-4 md:col-span-2 h-9 self-center px-2 py-1.5 border rounded-md text-sm text-right bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [-moz-appearance:textfield]"
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
      </div>
    );
  };

  const handleDeleteTax = (index: number) => {
    setTaxes(prev => prev.filter((_, i) => i !== index));
  };

  const subtotal = useMemo(() => roundMoney(items.reduce((sum, item) => sum + (item.total_price || 0), 0)), [items]);
  const taxesAndChargesTotal = useMemo(() => {
    const total = taxes.reduce((sum, tax) => {
      const amount = Number.isFinite(tax.amount) && tax.amount !== 0
        ? tax.amount
        : roundMoney(((tax.percent || 0) / 100) * subtotal);
      return sum + (amount || 0);
    }, 0);
    return roundMoney(total);
  }, [taxes, subtotal]);
  const total = useMemo(() => roundMoney(subtotal + taxesAndChargesTotal), [subtotal, taxesAndChargesTotal]);

  const handleValidate = () => {
    const editedData: ExtractedData = {
      ...extractedData,
      items,
      taxes_or_charges: taxes,
      subtotal,
      grand_total: total,
    };
    onValidate(editedData);
  };

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
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-gray-900">Items</h3>
                <Button size="sm" variant="outline" onClick={handleAddItem} type="button" className="px-2.5 py-1 text-xs">
                  <Plus className="h-4 w-4 mr-1" /> Add
                </Button>
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
                    {items.map((item, index) => (
                      <SortableItemRow key={item.__id ?? index} item={item} index={index} />
                    ))}
                  </div>
                </SortableContext>

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
                <Button size="sm" variant="outline" onClick={handleAddTax} type="button">
                  <Plus className="h-4 w-4 mr-1" /> Add Tax/Charge
                </Button>
              </div>
              <div className="space-y-2">
                {taxes.map((tax, index) => (
                  <div
                    key={index}
                    ref={(el) => { taxRowRefs.current[index] = el; }}
                    className="flex flex-col md:flex-row gap-2 md:items-center rounded-lg border border-gray-200 bg-white/80 p-3 shadow-sm"
                  >
                    <input
                      type="text"
                      value={tax.name}
                      onChange={(e) => handleTaxChange(index, 'name', e.target.value)}
                      placeholder="Tax/Charge name"
                      ref={(el) => { taxNameInputRefs.current[index] = el; }}
                      className="flex-1 h-10 px-3 py-2 border rounded-md text-sm bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    />
                    <input
                      type="number"
                      step="0.01"
                      value={tax.amount}
                      onChange={(e) => handleTaxChange(index, 'amount', parseFloat(e.target.value) || 0)}
                      placeholder="Amount"
                      className="w-full md:w-32 h-10 px-3 py-2 border rounded-md text-sm text-right bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    />
                    <button
                      onClick={() => handleDeleteTax(index)}
                      className="self-start md:self-center p-2 text-red-500 hover:bg-red-50 rounded-md"
                      type="button"
                      aria-label="Delete tax or charge"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
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
          <Button className="md:hidden" size="sm" onClick={handleValidate} type="button">
            {validationErrors ? 'Fix & Validate' : 'Confirm & Continue'}
          </Button>
          <Button className="hidden md:inline-flex" onClick={handleValidate} type="button">
            {validationErrors ? 'Fix & Validate' : 'Confirm & Continue'}
          </Button>
        </div>
      </div>
    </div>
  );
};
