declare module "@/db/repository" {
  export type UserSettings = {
    facilityId: number;
    facilityCategoryId: number;
    bookingLeadDays: number;
    releaseHour: number;
    releaseMinute: number;
    cancellationLeadSeconds: number;
    fireDelayMilliseconds: number;
    maximumSessions: number;
  };

  export type StoredSchedule = {
    id: string;
    userEmail: string;
    eventDay: string;
    eventTimes: string[];
    facilityId: number;
    facilityCategoryId: number;
    releaseAt: string;
    status: string;
    claimedAt: string | null;
    leaseUntil: string | null;
    attemptedAt: string | null;
    resultMessage: string | null;
    bookingOrderIds: number[];
    preparedTargets: unknown[];
    submittedTargets: unknown[];
    cancelledBookingIds: number[];
    submitSkewMs: number | null;
    createdAt: string;
    updatedAt: string;
  };
}
