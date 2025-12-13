import React, { useState } from 'react';
import { Card, CardContent } from '@/components/UI/Card';
import { Button } from '@/components/UI/Button';
import { Input } from '@/components/UI/Input';
import { Person } from '@/types/person.types';
import { User, Mail, Phone, Plus, Trash2, Users, AlertCircle } from 'lucide-react';

export interface ParticipantManagerProps {
  participants: Person[];
  knownParticipants?: Person[];
  onParticipantsChange: (participants: Person[]) => void;
  onNext: () => void;
  disabled?: boolean;
}

export const ParticipantManager: React.FC<ParticipantManagerProps> = ({
  participants,
  knownParticipants = [],
  onParticipantsChange,
  onNext,
  disabled = false,
}) => {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [tempPerson, setTempPerson] = useState<Partial<Person>>({});
  const [duplicateError, setDuplicateError] = useState('');

  const handleAddPerson = () => {
    const newPerson: Person = {
      id: `person_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: '',
      email: '',
      phone: '',
    };
    onParticipantsChange([...participants, newPerson]);
    setEditingIndex(participants.length);
    setTempPerson(newPerson);
  };

  const handleEditPerson = (index: number) => {
    setEditingIndex(index);
    setTempPerson({ ...participants[index] });
    setDuplicateError('');
  };

  const checkForDuplicateName = (name: string, currentIndex: number | null): boolean => {
    const trimmedName = name.trim().toLowerCase();
    return participants.some((person, index) => 
      index !== currentIndex && person.name.trim().toLowerCase() === trimmedName
    );
  };

  const handleSavePerson = () => {
    if (!tempPerson.name?.trim()) return;

    const trimmedName = tempPerson.name.trim();
    
    // Check for duplicate names - completely block duplicates
    if (checkForDuplicateName(trimmedName, editingIndex)) {
      // Don't save, just return - the validation will show in the UI
      return;
    }

    // Save the person
    const updatedParticipants = [...participants];
    if (editingIndex !== null) {
      updatedParticipants[editingIndex] = { 
        ...participants[editingIndex], 
        ...tempPerson,
        name: trimmedName
      };
    }
    onParticipantsChange(updatedParticipants);
    setEditingIndex(null);
    setTempPerson({});
  };

  const handleCancelEdit = () => {
    // If we were adding a new person (empty name), remove it
    if (editingIndex !== null && !participants[editingIndex]?.name.trim()) {
      const updatedParticipants = participants.filter((_, i) => i !== editingIndex);
      onParticipantsChange(updatedParticipants);
    }
    setEditingIndex(null);
    setTempPerson({});
    setDuplicateError('');
  };

  const handleRemovePerson = (index: number) => {
    const updatedParticipants = participants.filter((_, i) => i !== index);
    onParticipantsChange(updatedParticipants);
    
    // If we were editing the removed person, clear the editing state
    if (editingIndex === index) {
      setEditingIndex(null);
      setTempPerson({});
    } else if (editingIndex !== null && editingIndex > index) {
      // Adjust editing index if we removed someone before the current edit
      setEditingIndex(editingIndex - 1);
    }
  };

  const handleInputChange = (field: keyof Person, value: string) => {
    setTempPerson(prev => ({ ...prev, [field]: value }));
    
    // Clear duplicate error when user starts typing a new name
    if (field === 'name' && duplicateError) {
      setDuplicateError('');
    }
  };

  const handleNameBlur = () => {
    if (tempPerson.name?.trim()) {
      const trimmedName = tempPerson.name.trim();
      if (checkForDuplicateName(trimmedName, editingIndex)) {
        setDuplicateError(`The name "${trimmedName}" is already taken. Please choose a different name.`);
      }
    }
  };


  const canProceed = participants.length > 0 && 
                   participants.every(p => p.name.trim() !== '') && 
                   editingIndex === null;

  return (
    <>
      <div className="bg-gradient-to-br from-blue-50 via-white to-indigo-50 py-8 px-4">
        <div className="max-w-4xl mx-auto">
          {/* Hero Section */}
          <div className="text-center mb-8">
            <div className="mx-auto w-24 h-24 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-full flex items-center justify-center mb-6 shadow-lg">
              <Users className="h-12 w-12 text-white" />
            </div>
            <h1 className="text-4xl font-bold text-gray-900 mb-4">
              Who's Splitting the Bill?
            </h1>
            <p className="text-xl text-gray-600 max-w-2xl mx-auto mb-8">
              Add everyone who will be sharing this bill. You can always add or remove people later.
            </p>

            {/* Add Person Button - Only show when no participants and not editing */}
            {participants.length === 0 && editingIndex === null && (
              <div className="mb-8">
                <Button
                  onClick={handleAddPerson}
                  disabled={disabled}
                  leftIcon={<Plus className="h-5 w-5" />}
                  size="lg"
                  className="px-8 py-3 text-lg"
                >
                  Add Person
                </Button>
              </div>
            )}
          </div>

          {/* Known Participants - Quick Add */}
          {(() => {
            const availableParticipants = knownParticipants.filter(known => 
              !participants.some(p => p.id === known.id)
            );
            return availableParticipants.length > 0 && (
              <Card className="mb-8">
                <CardContent className="pt-6">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">
                    Previously Added People
                  </h3>
                  <p className="text-sm text-gray-600 mb-4">
                    Click to quickly add people you've used before:
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                    {availableParticipants.map(person => {
                      // Debug log (remove in production)
                      console.log('Rendering known participant:', person);
                      return (
                      <button
                        key={person.id}
                        onClick={() => {
                          const newParticipants = [...participants, person];
                          onParticipantsChange(newParticipants);
                        }}
                        disabled={disabled}
                        className="p-3 bg-blue-50 text-blue-700 rounded-lg border border-blue-200 hover:bg-blue-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-left"
                      >
                        <div className="flex items-center space-x-3">
                          <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                            <User className="h-5 w-5 text-blue-600" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="font-medium text-blue-900 truncate">
                              {person.name || 'Unnamed Person'}
                            </p>
                            {person.email && (
                              <p className="text-xs text-blue-600 truncate">{person.email}</p>
                            )}
                          </div>
                        </div>
                      </button>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          {/* Participants List */}
          {participants.length > 0 && (
            <Card className="mb-8">
              <CardContent className="space-y-6 pt-6">
                <div className="space-y-4">
                  {participants.map((person, index) => (
                    <div key={person.id} className="border border-gray-200 rounded-lg p-4 bg-white hover:shadow-sm transition-shadow">
                      {editingIndex === index ? (
                        <div className="space-y-4">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                              <Input
                                label="Name *"
                                value={tempPerson.name || ''}
                                onChange={(e) => handleInputChange('name', e.target.value)}
                                onBlur={handleNameBlur}
                                placeholder="Enter name"
                                leftIcon={<User className="h-4 w-4" />}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    handleSavePerson();
                                  } else if (e.key === 'Escape') {
                                    handleCancelEdit();
                                  }
                                }}
                                autoFocus
                                error={duplicateError}
                              />
                              {duplicateError && (
                                <p className="text-sm text-red-600 mt-1 flex items-center">
                                  <AlertCircle className="h-4 w-4 mr-1" />
                                  {duplicateError}
                                </p>
                              )}
                            </div>
                            <Input
                              label="Email (optional)"
                              type="email"
                              value={tempPerson.email || ''}
                              onChange={(e) => handleInputChange('email', e.target.value)}
                              placeholder="Enter email"
                              leftIcon={<Mail className="h-4 w-4" />}
                            />
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <Input
                              label="Phone (optional)"
                              value={tempPerson.phone || ''}
                              onChange={(e) => handleInputChange('phone', e.target.value)}
                              placeholder="Enter phone"
                              leftIcon={<Phone className="h-4 w-4" />}
                            />
                          </div>
                          <div className="flex space-x-2">
                            <Button
                              onClick={handleSavePerson}
                              disabled={!tempPerson.name?.trim() || disabled || !!duplicateError}
                              size="sm"
                            >
                              Save
                            </Button>
                            <Button
                              variant="outline"
                              onClick={handleCancelEdit}
                              size="sm"
                              disabled={disabled}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-3">
                            <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center">
                              <User className="h-5 w-5 text-blue-600" />
                            </div>
                            <div className="flex-1">
                              <h4 className="font-medium text-gray-900">
                                {person.name || <span className="text-gray-400 italic">Unnamed</span>}
                              </h4>
                              {person.email && (
                                <p className="text-sm text-gray-500 flex items-center">
                                  <Mail className="h-3 w-3 mr-1" />
                                  {person.email}
                                </p>
                              )}
                              {person.phone && (
                                <p className="text-sm text-gray-500 flex items-center">
                                  <Phone className="h-3 w-3 mr-1" />
                                  {person.phone}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="flex space-x-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleEditPerson(index)}
                              disabled={disabled}
                            >
                              Edit
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRemovePerson(index)}
                              disabled={disabled}
                              className="text-red-600 hover:text-red-700 hover:bg-red-50"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Add More Button - Show at bottom when there are participants and not currently editing */}
                {editingIndex === null && (
                  <div className="text-center pt-4">
                    <Button
                      variant="outline"
                      onClick={handleAddPerson}
                      disabled={disabled}
                      leftIcon={<Plus className="h-4 w-4" />}
                      size="lg"
                    >
                      Add Another Person
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Continue Button */}
          <div className="text-center">
            <Button
              onClick={onNext}
              disabled={!canProceed || disabled}
              size="lg"
              className="px-8 py-3 text-lg"
            >
              Continue to Receipt Upload
              <span className="ml-2">→</span>
            </Button>
            {!canProceed && participants.length > 0 && (
              <p className="text-sm text-gray-500 mt-2">
                {editingIndex !== null 
                  ? "Please save or cancel the current edit to continue"
                  : "Please ensure all participants have names to continue"
                }
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
};
