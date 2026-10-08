import React, { useState, useEffect, useRef } from 'react';
import { Header } from '@/components/Layout/Header';
import { Footer } from '@/components/Layout/Footer';
import { Container } from '@/components/Layout/Container';
import { ReceiptUploader } from '@/components/BillSplitter/ReceiptUploader';
import { ItemAssignment } from '@/components/BillSplitter/ItemAssignment';
import { SplitSummary } from '@/components/BillSplitter/SplitSummary';
import { ParticipantManager } from '@/components/BillSplitter/ParticipantManager';
import { useBillSplitter } from '@/hooks/useBillSplitter';
import { useReceiptOCR } from '@/hooks/useReceiptOCR';
import { usePersonManager } from '@/hooks/usePersonManager';
import { useItemAssignment, ItemSplit } from '@/hooks/useItemAssignment';
import { useCalculations } from '@/hooks/useCalculations';
import { useSession } from '@/hooks/useSession';
import { useValidationModal } from '@/hooks/useValidationModal';
import { ReceiptValidationModal } from '@/components/BillSplitter/ReceiptValidationModal';
import { ApiError } from '@/types/api.types';

const App: React.FC = () => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  
  // Initialize session (now fully local - no backend calls)
  const session = useSession();
  
  // Initialize other hooks with session actions
  const billSplitter = useBillSplitter({
    saveParticipants: session.actions.saveParticipants,
    saveReceiptData: session.actions.saveReceiptData,
    saveSplitResults: session.actions.saveSplitResults,
    saveOcrText: session.actions.saveOcrText,
  });
  const receiptOCR = useReceiptOCR();
  const personManager = usePersonManager();
  const itemAssignment = useItemAssignment(session.actions);
  const calculations = useCalculations();
  const validationModal = useValidationModal();

  const { createNewSession, restoreSession } = session.actions;
  const { restoreState } = billSplitter.actions;
  const { updateExtractedData, markAsValidated } = validationModal.actions;
  const { initializeAssignments } = itemAssignment.actions;
  const hasRestoredSessionRef = useRef(false);

  // Create session if none exists (local only - instant)
  useEffect(() => {
    if (!session.state.sessionToken && !session.state.hasExistingSession) {
      createNewSession();
    }
  }, [session.state.sessionToken, session.state.hasExistingSession, createNewSession]);

  // Restore session data if available
  useEffect(() => {
    const restoreSessionData = async () => {
      if (hasRestoredSessionRef.current) return;
      if (session.state.hasExistingSession && session.state.sessionData) {
        console.log('Restoring session data from localStorage...');
        const restoredData = await restoreSession();
        
        if (restoredData) {
          // Restore bill splitter state
          restoreState(restoredData);
          
          // If receipt data exists, restore validation modal state
          if (restoredData.receiptData) {
            updateExtractedData(restoredData.receiptData);
            markAsValidated(restoredData.receiptData);
            
            // Initialize item assignments (hydrate only; don't re-save to session)
            initializeAssignments(
              restoredData.receiptData.items,
              restoredData.itemAssignments,
              { persist: false }
            );
          }
          
          console.log('Session data restored successfully');
          hasRestoredSessionRef.current = true;
        }
      }
    };

    restoreSessionData();
  }, [
    session.state.hasExistingSession,
    session.state.sessionData,
    restoreSession,
    restoreState,
    updateExtractedData,
    markAsValidated,
    initializeAssignments,
  ]);

  const handleReceiptUpload = async (file: File) => {
    try {
      billSplitter.actions.setLoading(true);
      console.log('[App] Starting receipt upload for file:', file.name);

      // Upload and process receipt in one call (stateless)
      try {
        const response = await receiptOCR.actions.uploadAndProcessReceipt(file);
        console.log('[App] Process response:', response);

        // Save OCR text immediately
        if (response.ocr_text) {
          session.actions.saveOcrText(response.ocr_text);
        }

        if (response.processed_data) {
          console.log('[App] Setting receipt data');
          // Use file name as receipt ID since backend is stateless
          const receiptId = `receipt-${Date.now()}`;
          billSplitter.actions.setReceiptData(response.processed_data, receiptId, false);
          itemAssignment.actions.initializeAssignments(response.processed_data.items);

          // Store validation modal state globally
          const imagePreview = URL.createObjectURL(file);
          validationModal.actions.openModal(
            imagePreview,
            response.processed_data,
            null,
            response.ocr_text
          );
        }
      } catch (error) {
        const apiError = error as any;
        console.log('[App] Process error:', {
          status: apiError.status,
          message: apiError.message,
          details: apiError.details,
          needsValidation: receiptOCR.state.needsValidation
        });

        // Save OCR text even if processing failed
        const errorDetails = apiError.details?.detail || apiError.details;
        if (errorDetails?.raw_text) {
          session.actions.saveOcrText(errorDetails.raw_text);
        }

        // If validation error (422), show validation modal with error data
        if (apiError.status === 422 && errorDetails?.extracted_data) {
          const imagePreview = URL.createObjectURL(file);
          validationModal.actions.openModal(
            imagePreview,
            errorDetails.extracted_data,
            errorDetails,
            errorDetails.raw_text
          );
        } else {
          billSplitter.actions.setError('Failed to process receipt. Please try again.');
        }
      }
    } catch (error) {
      console.error('[App] Error processing receipt:', error);
      billSplitter.actions.setError('Failed to upload receipt. Please try again.');
    } finally {
      billSplitter.actions.setLoading(false);
    }
  };
  
  const handleValidationCorrection = async (correctedData: any, options?: { auto?: boolean }) => {
    try {
      billSplitter.actions.setLoading(true);
      const isAuto = options?.auto;

      // Save corrected data to session immediately
      console.log('[App] Saving corrected receipt data to session');
      const receiptId = billSplitter.state.receiptId || `receipt-${Date.now()}`;
      session.actions.saveReceiptData(correctedData, receiptId);

      // Check if this is the initial validation (no changes made) or reprocessing
      const baseExtractedData = validationModal.state.extractedData ?? receiptOCR.state.extractedData;
      const hasChanges = JSON.stringify(correctedData) !== JSON.stringify(baseExtractedData);

      if (hasChanges) {
        // User made changes, validate with corrected data (no receiptId needed)
        const processResponse = await receiptOCR.actions.validateCorrectedData(correctedData);

        if (!processResponse.processed_data) {
          billSplitter.actions.setError('Validation succeeded but no receipt data was returned. Please try again.');
          return;
        }

        billSplitter.actions.setReceiptData(processResponse.processed_data, receiptId, false);
        itemAssignment.actions.initializeAssignments(processResponse.processed_data.items);

        // Mark as validated in global state
        validationModal.actions.markAsValidated(processResponse.processed_data);

        if (!isAuto) {
          validationModal.actions.closeModal();
          // Always go to assignment page (step 3) after validation
          billSplitter.actions.goToStep(3);
        }
      } else {
        // No changes made, just proceed with existing data
        const processed = receiptOCR.state.processedData ?? validationModal.state.extractedData;
        if (!processed) {
          billSplitter.actions.setError('No receipt data available to continue. Please reprocess the receipt.');
          return;
        }

        billSplitter.actions.setReceiptData(processed, receiptId, false);
        itemAssignment.actions.initializeAssignments(processed.items);

        // Mark as validated in global state
        validationModal.actions.markAsValidated(processed);
        if (!isAuto) {
          validationModal.actions.closeModal();
          // Always go to assignment page (step 3) after validation
          billSplitter.actions.goToStep(3);
        }
      }
    } catch (error) {
      console.error('[App] Error validating receipt:', error);
      const apiError = error as ApiError;
      if (apiError.status === 422) {
        const errorDetails = apiError.details?.detail || apiError.details;
        if (validationModal.state.imageUrl) {
          validationModal.actions.openModal(
            validationModal.state.imageUrl,
            correctedData,
            errorDetails || apiError.message,
            receiptOCR.state.rawText || validationModal.state.ocrText
          );
          return;
        }
      }

      billSplitter.actions.setError('Failed to validate receipt. Please try again.');
    } finally {
      billSplitter.actions.setLoading(false);
    }
  };

  const handleReceiptProcessed = (receiptData: any, receiptId: string) => {
    billSplitter.actions.setReceiptData(receiptData, receiptId, true);
    itemAssignment.actions.initializeAssignments(receiptData.items);
    billSplitter.actions.nextStep();
  };

  const handleAssignItemToMultiplePeople = (
    itemIndex: number,
    personIds: string[],
    splitType: 'equal' | 'unequal',
    customSplits?: ItemSplit[],
    forceCustomSplit?: boolean
  ) => {
    itemAssignment.actions.assignItemToMultiplePeople(
      itemIndex,
      personIds,
      splitType,
      customSplits,
      forceCustomSplit
    );
  };

  const handleConfirmAssignment = () => {
    itemAssignment.actions.confirmPendingAssignment();
  };

  const handleCancelAssignment = () => {
    itemAssignment.actions.cancelPendingAssignment();
  };

  const handleCloseSplitModal = () => {
    itemAssignment.actions.closeSplitModal();
  };

  const handleCalculateSplit = () => {
    const receiptData = billSplitter.state.receiptData;
    const assignments = itemAssignment.state.assignments;
    const participants = billSplitter.state.participants;

    if (receiptData && assignments && participants) {
      const result = calculations.actions.calculateSplit(
        participants,
        assignments,
        receiptData
      );
      
      // Save split results to session
      if (result) {
        session.actions.saveSplitResults(result);
      }
      
      billSplitter.actions.nextStep();
    }
  };

  const handleBackFromItemAssignment = () => {
    // Prefer returning to the last validation view so users can correct numbers
    // without being dropped back into an empty "no receipt uploaded" state.
    if (validationModal.actions.canReopenModal()) {
      validationModal.actions.reopenModal();
      return;
    }

    billSplitter.actions.prevStep();
  };

  const handleStartOver = () => {
    // Reset all state and go back to step 1
    billSplitter.actions.reset();
    receiptOCR.actions.reset();
    personManager.actions.reset();
    itemAssignment.actions.reset();
    calculations.actions.reset();
    validationModal.actions.reset();
    // Known participants are preserved in localStorage
    console.log('Starting over - known participants preserved:', session.actions.getKnownParticipants().length);
  };

  const handleShare = () => {
    // Implement sharing functionality
    console.log('Share results');
  };

  const renderStep = () => {
    switch (billSplitter.state.currentStep) {
      case 1:
        return (
          <ParticipantManager
            participants={billSplitter.state.participants}
            knownParticipants={session.actions.getKnownParticipants()}
            onParticipantsChange={billSplitter.actions.setParticipants}
            onNext={billSplitter.actions.nextStep}
            disabled={billSplitter.state.isLoading}
          />
        );
      
      case 2:
        return (
          <ReceiptUploader
            onReceiptUploaded={handleReceiptUpload}
            onReceiptProcessed={(receiptData) => handleReceiptProcessed(receiptData, `receipt-${Date.now()}`)}
            onValidationCorrection={handleValidationCorrection}
            isLoading={receiptOCR.state.isUploading || receiptOCR.state.isProcessing}
            uploadProgress={receiptOCR.state.uploadProgress}
            error={receiptOCR.state.error}
            validationError={receiptOCR.state.validationError}
            needsValidation={receiptOCR.state.needsValidation}
            extractedData={receiptOCR.state.extractedData}
            disabled={billSplitter.state.isLoading}
          />
        );
      
        case 3:
          return (
            <ItemAssignment
              participants={billSplitter.state.participants}
              assignments={itemAssignment.state.assignments}
              onAssignItemToMultiplePeople={handleAssignItemToMultiplePeople}
              onConfirmAssignment={handleConfirmAssignment}
              onCancelAssignment={handleCancelAssignment}
              onUnassignItem={itemAssignment.actions.unassignItem}
              onCloseSplitModal={handleCloseSplitModal}
              onNext={handleCalculateSplit}
              onBack={handleBackFromItemAssignment}
              disabled={billSplitter.state.isLoading}
              pendingAssignment={itemAssignment.state.pendingAssignment}
              pendingSplitModal={itemAssignment.state.pendingSplitModal}
            />
          );
      
      case 4:
        return (
          <SplitSummary
            personSplits={calculations.state.personSplits}
            totalBill={calculations.state.totalBill}
            totalTax={calculations.state.totalTax}
            totalServiceCharge={calculations.state.totalServiceCharge}
            totalDiscount={calculations.state.totalDiscount}
            onStartOver={handleStartOver}
            onModifyAssignment={() => billSplitter.actions.goToStep(3)}
            onShare={handleShare}
            disabled={billSplitter.state.isLoading}
          />
        );
      
      default:
        return null;
    }
  };

  return (
    <div className="min-h-[100dvh] md:min-h-screen flex flex-col">
      <Header
        onMenuToggle={() => setIsMenuOpen(!isMenuOpen)}
        isMenuOpen={isMenuOpen}
      />
      
      <main className="flex-1 py-6 md:py-8">
        <Container className={billSplitter.state.currentStep === 3 ? 'px-4 sm:px-6 lg:px-8' : undefined}>
          {/* Session Error - now only for localStorage errors */}
          {session.state.error && (
            <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <div className="flex items-center space-x-2">
                <div className="text-yellow-500">⚠️</div>
                <p className="text-yellow-700">{session.state.error}</p>
              </div>
            </div>
          )}

          {/* Bill Splitter Error */}
          {billSplitter.state.error && (
            <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="flex items-center space-x-2">
                <div className="text-red-500">⚠️</div>
                <p className="text-red-700">{billSplitter.state.error}</p>
                <button
                  onClick={() => billSplitter.actions.setError(null)}
                  className="ml-auto text-red-500 hover:text-red-700"
                >
                  ✕
                </button>
              </div>
            </div>
          )}

          {/* Validation Status Indicator - Only show in Assignment page (step 3) */}
          {validationModal.state.hasValidatedData && billSplitter.state.currentStep === 3 && (
            <div className="mb-4 bg-green-50 border border-green-200 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <div className="text-green-500">✓</div>
                  <p className="text-green-700 text-sm">Receipt data has been validated</p>
                </div>
                {validationModal.actions.canReopenModal() && (
                  <button
                    onClick={validationModal.actions.reopenModal}
                    className="text-green-600 hover:text-green-800 text-sm font-medium"
                  >
                    Revalidate Receipt Data
                  </button>
                )}
              </div>
            </div>
          )}
          
          {renderStep()}
        </Container>
      </main>
      
      {/* Global Validation Modal */}
      {validationModal.state.isOpen && validationModal.state.imageUrl && validationModal.state.extractedData && (
        <ReceiptValidationModal
          isOpen={validationModal.state.isOpen}
          onClose={validationModal.actions.closeModal}
          imageUrl={validationModal.state.imageUrl}
          extractedData={validationModal.state.extractedData}
          validationErrors={validationModal.state.validationErrors}
          onValidate={handleValidationCorrection}
        />
      )}
      
      <Footer />
    </div>
  );
};

export default App;
