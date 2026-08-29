'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { createAnimeAction } from '@/features/anime/anime-actions';
import { ANIME_FORMATS, ANIME_STATUSES, FORMAT_LABELS, STATUS_LABELS } from '@/server/anime/taxonomy';

/**
 * Adding a show by hand.
 *
 * The owner's stated plan is to migrate from AniList once and then track in
 * Burmy directly, so this is the path that matters after the import — not a
 * fallback for when the sync fails.
 *
 * DELIBERATELY SHORT, but not shorter than the stats need. Title, status,
 * format, episode count, episode length, progress, year, studio and genres.
 *
 * Studio and genres are here for a specific reason rather than completeness:
 * they are what the Stats page's two largest charts are built from, and a show
 * added without them is invisible in both. Everything a chart needs is worth
 * asking for once; synopsis, dates and notes are not, and are left to inline
 * editing on the show's page where there is room. A dialog that asks for
 * eighteen fields before it will save anything is a dialog people avoid.
 *
 * A hand-added row carries no `anilistMediaId`, so a later sync leaves it
 * entirely alone — nothing typed here can be overwritten by AniList.
 */
export function AnimeDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string>('watching');
  const [format, setFormat] = useState<string>('tv');

  async function submit(formData: FormData): Promise<void> {
    setPending(true);
    try {
      const result = await createAnimeAction(formData);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Show added');
      onOpenChange(false);
    } catch {
      toast.error('That did not save. Nothing was added.');
    } finally {
      // `finally`, never a line after the await — a REJECTED action skips it
      // and leaves the form permanently disabled.
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a show</DialogTitle>
        </DialogHeader>

        <form action={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="titleRomaji">Title</Label>
            <Input id="titleRomaji" name="titleRomaji" required autoFocus maxLength={300} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="status">Status</Label>
              {/* A hidden input carries the value: Radix's Select is not a
                  native form control, so `action={…}` would otherwise receive
                  nothing for it. */}
              <input type="hidden" name="status" value={status} />
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger id="status" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ANIME_STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {STATUS_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="format">Format</Label>
              <input type="hidden" name="format" value={format} />
              <Select value={format} onValueChange={setFormat}>
                <SelectTrigger id="format" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ANIME_FORMATS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {FORMAT_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="progress">Episodes watched</Label>
              <Input id="progress" name="progress" inputMode="numeric" placeholder="0" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="episodes">Episodes total</Label>
              <Input id="episodes" name="episodes" inputMode="numeric" placeholder="Unknown" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="durationMinutes">Episode length</Label>
              <Input id="durationMinutes" name="durationMinutes" inputMode="numeric" placeholder="Minutes" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="seasonYear">Year</Label>
              <Input id="seasonYear" name="seasonYear" inputMode="numeric" placeholder="Unknown" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="studio">Studio</Label>
              <Input id="studio" name="studio" maxLength={300} placeholder="Optional" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="genre">Genres</Label>
              {/* Comma-separated, matching how the column is stored and split
                  at read time — the same shape `games.genre` uses. Said in the
                  placeholder, because a bare "Genres" box invites one genre. */}
              <Input id="genre" name="genre" maxLength={300} placeholder="Action, Drama" />
            </div>
          </div>

          {/* Said in the form, not learned afterwards. Both of these are
              fields whose absence is invisible later: no episode length means
              no time-watched figure anywhere in the app, and no studio or
              genres means this show is missing from the two largest charts on
              the Stats page. A blank stat is confusing in a way a one-line
              warning is not. */}
          <p className="text-muted-foreground text-xs">
            Episode length is what makes time-watched figures possible; studio and genres are what put
            this show in the stats. All three can be filled in later from the show&apos;s own page.
          </p>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Adding…' : 'Add show'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
