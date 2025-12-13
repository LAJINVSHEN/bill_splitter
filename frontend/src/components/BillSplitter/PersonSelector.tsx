import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/UI/Card';
import { Button } from '@/components/UI/Button';
import { Users, Plus, Minus } from 'lucide-react';

export interface PersonSelectorProps {
  numberOfPeople: number;
  onNumberOfPeopleChange: (count: number) => void;
  onNext: () => void;
  disabled?: boolean;
}

export const PersonSelector: React.FC<PersonSelectorProps> = ({
  numberOfPeople,
  onNumberOfPeopleChange,
  onNext,
  disabled = false,
}) => {
  const handleIncrement = () => {
    if (numberOfPeople < 20) { // Reasonable limit
      onNumberOfPeopleChange(numberOfPeople + 1);
    }
  };

  const handleDecrement = () => {
    if (numberOfPeople > 1) {
      onNumberOfPeopleChange(numberOfPeople - 1);
    }
  };

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawValue = e.target.value;
    if (rawValue === '') {
      onNumberOfPeopleChange(0);
      return;
    }

    const value = parseInt(rawValue, 10);
    if (value >= 1 && value <= 20) {
      onNumberOfPeopleChange(value);
    }
  };

  return (
    <Card className="max-w-md mx-auto">
      <CardHeader className="text-center">
        <div className="mx-auto w-16 h-16 bg-primary-100 rounded-full flex items-center justify-center mb-4">
          <Users className="h-8 w-8 text-primary-600" />
        </div>
        <CardTitle>How many people are splitting the bill?</CardTitle>
        <CardDescription>
          Enter the number of people who will be sharing this bill
        </CardDescription>
      </CardHeader>
      
      <CardContent className="space-y-6">
        <div className="flex items-center justify-center space-x-4">
          <Button
            variant="outline"
            size="lg"
            onClick={handleDecrement}
            disabled={numberOfPeople <= 1 || disabled}
            leftIcon={<Minus className="h-4 w-4" />}
          >
            Remove
          </Button>
          
          <div className="flex flex-col items-center space-y-2">
            <input
              type="number"
              min="1"
              max="20"
              value={numberOfPeople === 0 ? '' : numberOfPeople}
              onChange={handleNumberChange}
              onFocus={(e) => e.target.select()}
              className="w-20 text-center text-3xl font-bold border-0 border-b-2 border-primary-600 focus:outline-none focus:border-primary-700"
              disabled={disabled}
            />
            <span className="text-sm text-gray-500">people</span>
          </div>
          
          <Button
            variant="outline"
            size="lg"
            onClick={handleIncrement}
            disabled={numberOfPeople >= 20 || disabled}
            leftIcon={<Plus className="h-4 w-4" />}
          >
            Add
          </Button>
        </div>

        <div className="text-center">
          <Button
            onClick={onNext}
            disabled={numberOfPeople < 1 || disabled}
            size="lg"
            className="w-full"
          >
            Continue to Names
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
