import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBrowserDate,resolveBrowserTargetDate,browserLocalDate,browserDateEpoch,resolveBrowserDateRange} from '../utils/browserCalendar';
const now=new Date('2026-11-01T09:00:00Z');
test('rendered Russian/English dates retain the real year and Moscow midnight',()=>{
    for(const text of ['6 Ноября','6 ноября 2026','6 November 2026','06.11.2026','06-11-2026','2026-11-06']){
        const date=parseBrowserDate(text,now,'Europe/Moscow');assert.equal(date?.localDate,'2026-11-06',text);
        assert.equal(new Date(date!.ms).toISOString(),'2026-11-05T21:00:00.000Z');
    }
    assert.equal(parseBrowserDate('31 ноября',now),null);
});
test('next Friday and relative days use the supplied clock/timezone rather than host local time',()=>{
    for(const text of ['А что из этого на следующую пятницу?','next Friday','в пятницу'])assert.equal(resolveBrowserTargetDate(text,now,'Europe/Moscow'),'2026-11-06');
    assert.equal(resolveBrowserTargetDate('следующую пятницу',new Date('2026-11-06T09:00:00Z')),'2026-11-13');
    const midnight=new Date('2026-11-01T21:30:00Z');assert.equal(browserLocalDate(midnight,'Europe/Moscow'),'2026-11-02');
    assert.equal(resolveBrowserTargetDate('завтра',midnight,'Europe/Moscow'),'2026-11-03');
    assert.equal(resolveBrowserTargetDate('завтра',midnight,'UTC'),'2026-11-02');
});
test('ambiguous day choices and exclusions are not reduced to an arbitrary weekday',()=>{
    for(const text of ['не в пятницу, а в субботу','в пятницу или в субботу','not tomorrow','except Friday'])assert.equal(resolveBrowserTargetDate(text,now),null,text);
    assert.equal(resolveBrowserDateRange('на этой и следующей неделе',now),null);
});
test('week ranges and year rollover retain calendar boundaries in the browser timezone',()=>{
    const range=resolveBrowserDateRange('на следующей неделе',now)!;
    assert.equal(new Date(range.startMs).toISOString(),'2026-11-01T21:00:00.000Z');
    assert.equal(new Date(range.endMs).toISOString(),'2026-11-08T21:00:00.000Z');
    assert.equal(parseBrowserDate('2 января',new Date('2026-12-31T09:00:00Z'))?.localDate,'2027-01-02');
    assert.equal(parseBrowserDate('29 февраля 2027',now),null);
    assert.throws(()=>browserDateEpoch('2026-11-06','Europe/Moscow','bad'));
    assert.throws(()=>browserDateEpoch('2026-03-29','Europe/Amsterdam','02:30'));
});
test('flexible next calendar week retains the whole range in the account timezone',()=>{
    const range=resolveBrowserDateRange('цены на следующую неделю',now,'Europe/Amsterdam')!;
    assert.equal(browserLocalDate(new Date(range.startMs),'Europe/Amsterdam'),'2026-11-02');
    assert.equal(browserLocalDate(new Date(range.endMs-1),'Europe/Amsterdam'),'2026-11-08');
});
