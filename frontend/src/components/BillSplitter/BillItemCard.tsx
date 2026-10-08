import React from 'react';
import { Card, CardContent } from '@/components/UI/Card';
import { Button } from '@/components/UI/Button';
import { BillItem } from '@/types/bill.types';
import { ItemAssignment } from '@/hooks/useItemAssignment';
import { formatCurrency } from '@/utils/formatters';
import { Package, Users, Check, AlertCircle } from 'lucide-react';

export interface BillItemCardProps {
  item: BillItem;
  index: number;
  assignment: ItemAssignment;
  participants: Array<{ id: string; name: string }>;
  onUnassign: (itemIndex: number) => void;
  onMultipleAssign: (itemIndex: number, personIds: string[], forceCustomSplit?: boolean) => void;
  disabled?: boolean;
}

export const BillItemCard: React.FC<BillItemCardProps> = ({
  item,
  index,
  assignment,
  participants,
  onUnassign,
  onMultipleAssign,
  disabled = false,
}) => {
  const assignedPeopleCount = assignment.isMultipleAssignment
    ? assignment.splits.length
    : assignment.assignedTo
      ? 1
      : 0;
  const hasQuantityMismatch = item.quantity > 1
    && assignedPeopleCount > 0
    && assignedPeopleCount !== item.quantity;

  const handleAssign = (personId: string) => {
    // Get current selection state
    const currentAssignedPeople = assignment.isMultipleAssignment 
      ? assignment.splits.map(s => s.personId)
      : assignment.assignedTo 
        ? [assignment.assignedTo]
        : [];
    
    // Toggle person selection and auto-assign immediately
    const newSelectedPeople = currentAssignedPeople.includes(personId) 
      ? currentAssignedPeople.filter(id => id !== personId)
      : [...currentAssignedPeople, personId];
    
    // Auto-assign immediately with equal split by default
    if (newSelectedPeople.length > 0) {
      onMultipleAssign(index, newSelectedPeople, false); // false = don't force custom split
    } else {
      // If no one selected, unassign the item
      onUnassign(index);
    }
  };


  const handleCustomSplit = () => {
    // Trigger the custom split modal
    const personIds = assignment.isMultipleAssignment 
      ? assignment.splits.map(s => s.personId)
      : [];
    
    if (personIds.length > 1) {
      // This will open the split choice modal for custom splits
      onMultipleAssign(index, personIds, true); // Pass true to indicate custom split request
    }
  };


  return (
    <Card padding="none" className="hover:shadow-md transition-shadow border border-gray-100 w-full overflow-hidden">
      <CardContent className="p-3 md:p-4 min-w-0">
        <div className="flex flex-col gap-3 md:grid md:grid-cols-[minmax(0,1fr)_minmax(220px,0.9fr)] md:items-start md:gap-4 w-full min-w-0">
          <div className="flex-1 min-w-0 space-y-2.5">
            <div className="flex items-center space-x-2 min-w-0">
              <Package className="h-4 w-4 text-gray-400" />
              <h4 className="min-w-0 flex-1 text-sm md:text-base font-medium text-gray-900 truncate">
                {item.name}
              </h4>
              {assignment.isMultipleAssignment && (
                <span title="Split among multiple people">
                  <Users className="h-4 w-4 text-blue-500" />
                </span>
              )}
              {/* Custom split link - desktop */}
              {assignment.isMultipleAssignment && assignment.splits.length > 1 && (
                <button
                  onClick={handleCustomSplit}
                  disabled={disabled}
                  className="hidden md:inline ml-auto text-xs text-blue-600 hover:text-blue-700 underline cursor-pointer"
                >
                  Custom split
                </button>
              )}
            </div>
            
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs md:text-sm text-gray-500">
              <span>Qty {item.quantity}</span>
              <span>@ {formatCurrency(item.unit_price)}</span>
              <span className="font-medium text-gray-900">
                Total {formatCurrency(item.total_price)}
              </span>
            </div>

            {/* Custom split button - mobile */}
            {assignment.isMultipleAssignment && assignment.splits.length > 1 && (
              <div className="mt-3 md:hidden">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCustomSplit}
                  disabled={disabled}
                  className="w-full justify-center text-xs"
                >
                  Custom split
                </Button>
              </div>
            )}

            {hasQuantityMismatch && (
              <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800 md:text-sm">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <p className="leading-snug">
                  Quantity is {item.quantity}, but assigned to {assignedPeopleCount} {assignedPeopleCount === 1 ? 'person' : 'people'}. Adjust splits if you want them to match.
                </p>
              </div>
            )}
          </div>

          <div className="w-full md:w-auto flex-shrink-0 md:justify-self-end md:min-w-[220px] min-w-0">
            <div className="text-left md:text-right space-y-2 w-full">
              <p className="text-xs md:text-sm text-gray-500 mb-2">Select people:</p>
              <div className="flex flex-wrap gap-2 justify-center md:justify-end w-full min-w-0">
                {participants.map((person) => {
                  const isSelected = assignment.isMultipleAssignment 
                    ? assignment.splits.some(s => s.personId === person.id)
                    : assignment.assignedTo === person.id;
                  
                  return (
                    <Button
                      key={person.id}
                      variant={isSelected ? "primary" : "outline"}
                      size="sm"
                      onClick={() => handleAssign(person.id)}
                      disabled={disabled}
                      className="text-[11px] md:text-xs px-3 py-2 min-w-[44px] max-w-full justify-center"
                      title={person.name}
                    >
                      {isSelected && <Check className="h-3 w-3 mr-1" />}
                      <span className="truncate max-w-[6.5rem] md:max-w-none">{person.name}</span>
                    </Button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
