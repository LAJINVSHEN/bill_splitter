import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/UI/Card';
import { Button } from '@/components/UI/Button';
import { ConfirmationModal } from '@/components/UI/ConfirmationModal';
import { SplitChoiceModal } from '@/components/UI/SplitChoiceModal';
import { BillItemCard } from './BillItemCard';
import { Person } from '@/types/person.types';
import { ItemAssignment as ItemAssignmentType, ItemSplit } from '@/hooks/useItemAssignment';
import { ShoppingCart, CheckCircle, AlertCircle } from 'lucide-react';

interface DuplicateAssignmentInfo {
  itemName: string;
  personId: string;
  personName: string;
  existingCount: number;
  newCount: number;
}

export interface ItemAssignmentProps {
  participants: Person[];
  assignments: ItemAssignmentType[];
  onAssignItemToMultiplePeople: (itemIndex: number, personIds: string[], splitType: 'equal' | 'unequal', customSplits?: ItemSplit[], forceCustomSplit?: boolean) => void;
  onConfirmAssignment: () => void;
  onCancelAssignment: () => void;
  onUnassignItem: (itemIndex: number) => void;
  onCloseSplitModal: () => void;
  onNext: () => void;
  onBack: () => void;
  disabled?: boolean;
  pendingAssignment?: {
    itemIndex: number;
    personId: string;
    duplicateInfo: DuplicateAssignmentInfo | null;
  } | null;
  pendingSplitModal?: {
    itemIndex: number;
    personIds: string[];
  } | null;
}

export const ItemAssignment: React.FC<ItemAssignmentProps> = ({
  participants,
  assignments,
  onAssignItemToMultiplePeople,
  onConfirmAssignment,
  onCancelAssignment,
  onUnassignItem,
  onCloseSplitModal,
  onNext,
  onBack,
  disabled = false,
  pendingAssignment = null,
  pendingSplitModal = null,
}) => {
  const assignedCount = assignments.filter(a => a.assignedTo !== null || a.isMultipleAssignment).length;
  const totalCount = assignments.length;
  const allAssigned = assignedCount === totalCount;

  const handleMultipleAssign = (itemIndex: number, personIds: string[], forceCustomSplit?: boolean) => {
    // If forceCustomSplit is true, open the split choice modal
    // Otherwise, assign with equal split by default
    onAssignItemToMultiplePeople(itemIndex, personIds, 'equal', undefined, forceCustomSplit);
  };

  // Generate confirmation modal content
  const getModalContent = () => {
    if (!pendingAssignment?.duplicateInfo) return { title: '', message: '', details: [] };

    const { duplicateInfo } = pendingAssignment;
    const title = 'Duplicate Item Assignment';
    const message = `You are about to assign "${duplicateInfo.itemName}" to ${duplicateInfo.personName} for the ${duplicateInfo.newCount}${getOrdinalSuffix(duplicateInfo.newCount)} time.`;
    
    const details = [
      `Item: ${duplicateInfo.itemName}`,
      `Person: ${duplicateInfo.personName}`,
      `Current assignments: ${duplicateInfo.existingCount}`,
      `Total after assignment: ${duplicateInfo.newCount}`,
    ];

    return { title, message, details };
  };

  const getOrdinalSuffix = (num: number): string => {
    const remainder10 = num % 10;
    const remainder100 = num % 100;
    
    if (remainder100 >= 11 && remainder100 <= 13) {
      return 'th';
    }
    
    switch (remainder10) {
      case 1: return 'st';
      case 2: return 'nd';
      case 3: return 'rd';
      default: return 'th';
    }
  };

  const handleSplitConfirm = (splitType: 'equal' | 'unequal', customSplits?: ItemSplit[]) => {
    if (pendingSplitModal) {
      onAssignItemToMultiplePeople(
        pendingSplitModal.itemIndex,
        pendingSplitModal.personIds,
        splitType,
        customSplits
      );
    }
  };

  const modalContent = getModalContent();

  return (
    <>
      <div className="px-4 sm:px-5">
        <Card padding="none" className="max-w-4xl mx-auto w-full overflow-hidden rounded-xl shadow-sm">
          <CardHeader className="text-center px-3 py-3 md:px-5 md:py-4">
            <div className="mx-auto w-10 h-10 md:w-12 md:h-12 bg-primary-100 rounded-full flex items-center justify-center mb-2 md:mb-3">
              <ShoppingCart className="h-5 w-5 md:h-6 md:w-6 text-primary-600" />
            </div>
            <CardTitle className="text-base md:text-lg">Assign Items to People</CardTitle>
            <CardDescription className="text-sm">
              Click on a person's name to assign each item. Click additional people to split an item.
            </CardDescription>
            
            <div className="flex items-center justify-center space-x-3 mt-3">
              <div className="flex items-center space-x-2">
                {allAssigned ? (
                  <CheckCircle className="h-5 w-5 text-green-500" />
                ) : (
                  <AlertCircle className="h-5 w-5 text-yellow-500" />
                )}
                <span className="text-xs md:text-sm font-medium">
                  {assignedCount} of {totalCount} items assigned
                </span>
              </div>
            </div>
          </CardHeader>
          
          <CardContent className="space-y-4 md:space-y-5 px-3 pb-4 md:px-5 md:pb-5 overflow-x-hidden">
            <div className="grid gap-3 md:gap-4">
              {assignments.map((assignment, index) => (
                <BillItemCard
                  key={`${assignment.item.name}-${index}`}
                  item={assignment.item}
                  index={index}
                  assignment={assignment}
                  participants={participants}
                  onUnassign={onUnassignItem}
                  onMultipleAssign={handleMultipleAssign}
                  disabled={disabled}
                />
              ))}
            </div>

            {!allAssigned && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <div className="flex items-center space-x-2">
                  <AlertCircle className="h-5 w-5 text-yellow-500" />
                  <p className="text-sm text-yellow-700">
                    Please assign all items before proceeding. {totalCount - assignedCount} item(s) remaining.
                  </p>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between pt-4">
              <Button
                variant="outline"
                onClick={onBack}
                disabled={disabled}
              >
                Back
              </Button>
              <Button
                onClick={onNext}
                disabled={!allAssigned || disabled}
              >
                Calculate Split
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Duplicate Assignment Confirmation Modal */}
      <ConfirmationModal
        isOpen={!!pendingAssignment?.duplicateInfo}
        onClose={onCancelAssignment}
        onConfirm={onConfirmAssignment}
        title={modalContent.title}
        message={modalContent.message}
        details={modalContent.details}
        confirmText="Yes, Assign Anyway"
        cancelText="Cancel"
        variant="warning"
      />

      {/* Split Choice Modal */}
      {pendingSplitModal && (
        <SplitChoiceModal
          isOpen={!!pendingSplitModal}
          onClose={onCloseSplitModal}
          onConfirm={handleSplitConfirm}
          item={assignments[pendingSplitModal.itemIndex]?.item}
          personIds={pendingSplitModal.personIds}
          participants={participants}
        />
      )}
    </>
  );
};
