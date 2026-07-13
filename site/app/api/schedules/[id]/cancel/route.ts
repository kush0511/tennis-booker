import { cancelSchedule } from "@/db/repository";
import {
  data,
  HttpError,
  requireApiUser,
  requireSameOrigin,
  routeError,
} from "@/app/_server/api";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    requireSameOrigin(request);
    const user = await requireApiUser();
    const id = (await context.params).id;
    if (!id || !(await cancelSchedule(id, user.email))) {
      throw new HttpError(409, "Only a pending schedule can be cancelled.");
    }
    return data({ cancelled: true });
  } catch (error) {
    return routeError(error);
  }
}
