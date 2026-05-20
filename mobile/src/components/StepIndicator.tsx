import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

const STEPS = ['Photo', 'Location', 'Questions', 'Review', 'Submit'];

type StepIndicatorProps = {
  currentStep: number; // 1-indexed: 1=Photo, 2=Location, 3=Questions, 4=Review, 5=Submit
};

export default function StepIndicator({ currentStep }: StepIndicatorProps) {
  return (
    <View style={styles.container}>
      {/* Progress bar */}
      <View style={styles.barTrack}>
        <View
          style={[
            styles.barFill,
            { width: `${((currentStep - 1) / (STEPS.length - 1)) * 100}%` as any },
          ]}
        />
      </View>

      {/* Step labels */}
      <View style={styles.labelsRow}>
        {STEPS.map((label, index) => {
          const stepNumber = index + 1;
          const isActive = stepNumber === currentStep;
          const isComplete = stepNumber < currentStep;
          return (
            <View key={label} style={styles.labelItem}>
              {/* Step dot */}
              <View
                style={[
                  styles.dot,
                  isComplete && styles.dotComplete,
                  isActive && styles.dotActive,
                ]}
              >
                {isComplete && <Text style={styles.dotCheck}>✓</Text>}
                {!isComplete && (
                  <Text style={[styles.dotNumber, isActive && styles.dotNumberActive]}>
                    {stepNumber}
                  </Text>
                )}
              </View>
              {/* Step label */}
              <Text
                style={[
                  styles.label,
                  isActive && styles.labelActive,
                  isComplete && styles.labelComplete,
                ]}
                numberOfLines={1}
              >
                {label}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
    backgroundColor: '#FFFFFF',
  },
  barTrack: {
    height: 3,
    backgroundColor: '#E0E0E0',
    borderRadius: 2,
    marginBottom: 8,
    marginHorizontal: 20,
  },
  barFill: {
    height: 3,
    backgroundColor: '#0468B1',
    borderRadius: 2,
  },
  labelsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  labelItem: {
    alignItems: 'center',
    flex: 1,
  },
  dot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#CCCCCC',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 3,
  },
  dotActive: {
    borderColor: '#0468B1',
    backgroundColor: '#0468B1',
  },
  dotComplete: {
    borderColor: '#0468B1',
    backgroundColor: '#0468B1',
  },
  dotNumber: {
    fontSize: 10,
    fontWeight: '600',
    color: '#CCCCCC',
  },
  dotNumberActive: {
    color: '#FFFFFF',
  },
  dotCheck: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  label: {
    fontSize: 10,
    color: '#999999',
    textAlign: 'center',
  },
  labelActive: {
    color: '#0468B1',
    fontWeight: '600',
  },
  labelComplete: {
    color: '#0468B1',
  },
});
