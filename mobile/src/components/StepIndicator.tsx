import React from 'react';
import { View, Text, StyleSheet, Dimensions } from 'react-native';

const { width: screenWidth } = Dimensions.get('window');
const scale = (size: number) => Math.round((screenWidth / 375) * size);

const STEPS = [
  { label: 'PHOTO', icon: '📷' },
  { label: 'LOCATION', icon: '📍' },
  { label: 'QUESTIONS', icon: '📋' },
  { label: 'REVIEW', icon: '👁' },
  { label: 'SUBMIT', icon: '✓' },
];

type StepIndicatorProps = {
  currentStep: number; // 1-indexed: 1=Photo, 2=Location, 3=Questions, 4=Review, 5=Submit
};

export default function StepIndicator({ currentStep }: StepIndicatorProps) {
  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {STEPS.map((step, index) => {
          const stepNumber = index + 1;
          const isActive = stepNumber === currentStep;
          const isComplete = stepNumber < currentStep;
          const isPending = stepNumber > currentStep;

          return (
            <React.Fragment key={step.label}>
              {/* Connecting line before this step (skip for first) */}
              {index > 0 && (
                <View
                  style={[
                    styles.connector,
                    isComplete || (isActive && index > 0)
                      ? styles.connectorComplete
                      : styles.connectorPending,
                  ]}
                />
              )}

              {/* Step circle + label */}
              <View style={styles.stepCol}>
                {/* Active ring wrapper */}
                <View
                  style={[
                    styles.ringWrapper,
                    isActive && styles.ringWrapperActive,
                  ]}
                >
                  <View
                    style={[
                      styles.circle,
                      isComplete && styles.circleComplete,
                      isActive && styles.circleActive,
                      isPending && styles.circlePending,
                    ]}
                  >
                    <Text
                      style={[
                        styles.circleIcon,
                        isPending && styles.circleIconPending,
                      ]}
                    >
                      {isComplete ? '✓' : step.icon}
                    </Text>
                  </View>
                </View>

                <Text
                  style={[
                    styles.label,
                    (isActive || isComplete) && styles.labelActive,
                    isPending && styles.labelPending,
                  ]}
                  numberOfLines={1}
                >
                  {step.label}
                </Text>
              </View>
            </React.Fragment>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: screenWidth * 0.06,
    paddingVertical: 16,
    backgroundColor: '#FFFFFF',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  connector: {
    flex: 1,
    height: 2,
    marginHorizontal: 2,
    alignSelf: 'flex-start',
    marginTop: 20, // vertically center with circles (half of largest circle 40/2)
  },
  connectorComplete: {
    backgroundColor: '#0468B1',
  },
  connectorPending: {
    backgroundColor: '#E4E2E1',
  },
  stepCol: {
    alignItems: 'center',
    minWidth: scale(44),
  },
  ringWrapper: {
    width: scale(46),
    height: scale(46),
    borderRadius: scale(23),
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  ringWrapperActive: {
    borderWidth: 3,
    borderColor: 'rgba(4,104,177,0.2)',
  },
  circle: {
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 999,
  },
  circleComplete: {
    width: scale(36),
    height: scale(36),
    backgroundColor: '#0468B1',
  },
  circleActive: {
    width: scale(40),
    height: scale(40),
    backgroundColor: '#0468B1',
  },
  circlePending: {
    width: scale(32),
    height: scale(32),
    backgroundColor: '#E4E2E1',
  },
  circleIcon: {
    fontSize: scale(14),
    color: '#FFFFFF',
  },
  circleIconPending: {
    color: '#717782',
  },
  label: {
    marginTop: 5,
    fontSize: scale(10),
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  labelActive: {
    color: '#0468B1',
  },
  labelPending: {
    color: '#9CA3AF',
    fontWeight: '500',
  },
});
