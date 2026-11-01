/** Calendar dates belong to the website/workspace timezone, never the worker host timezone. */
import { USER_TIMEZONE } from '../constants';
export const BROWSER_TIME_ZONE = USER_TIMEZONE;
const MONTHS = ['января|январь|january|jan','февраля|февраль|february|feb','марта|март|march|mar','апреля|апрель|april|apr',
    'мая|май|may','июня|июнь|june|jun','июля|июль|july|jul','августа|август|august|aug','сентября|сентябрь|september|sept|sep',
    'октября|октябрь|october|oct','ноября|ноябрь|november|nov','декабря|декабрь|december|dec'];
export interface BrowserDate { text: string; localDate: string; ms: number; timeZone: string }
export function browserLocalDate(now = new Date(), timeZone = BROWSER_TIME_ZONE): string {
    const parts = new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
    const get = (type: string) => parts.find(part=>part.type===type)!.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
}
function validDate(year: number, month: number, day: number): string | null {
    const value = new Date(Date.UTC(year,month-1,day));
    return value.getUTCFullYear()===year && value.getUTCMonth()===month-1 && value.getUTCDate()===day
        ? `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}` : null;
}
export function shiftBrowserDate(date: string, days: number): string {
    const value = new Date(date+'T12:00:00Z'); value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10);
}
export function browserDateEpoch(localDate: string, timeZone = BROWSER_TIME_ZONE, localTime = '00:00'): number {
    const [year,month,day] = localDate.split('-').map(Number), [hour,minute] = localTime.split(':').map(Number);
    if (!validDate(year,month,day) || !Number.isInteger(hour) || !Number.isInteger(minute) || hour<0 || hour>23 || minute<0 || minute>59) throw Error('Invalid browser calendar date/time');
    const target=Date.UTC(year,month-1,day,hour,minute); let epoch=target;
    const format=new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
    for(let i=0;i<3;i++) {
        const parts=format.formatToParts(new Date(epoch));const get=(key:string)=>Number(parts.find(p=>p.type===key)!.value);
        const observed=Date.UTC(get('year'),get('month')-1,get('day'),get('hour'),get('minute'));
        if(observed===target)return epoch;
        epoch+=target-observed;
    }
    throw Error('Ambiguous or nonexistent local browser date/time');
}
export function parseBrowserDate(text: string, now = new Date(), timeZone = BROWSER_TIME_ZONE): BrowserDate | null {
    const today=browserLocalDate(now,timeZone), currentYear=Number(today.slice(0,4));
    const make=(day:number,month:number,year:number|undefined,source:string):BrowserDate|null=>{
        let date=validDate(year??currentYear,month,day);if(!date)return null;
        if(!year && date<shiftBrowserDate(today,-30))date=validDate(currentYear+1,month,day);
        return date ? {text:source.trim(),localDate:date,ms:browserDateEpoch(date,timeZone),timeZone} : null;
    };
    const iso=text.match(/(?:^|[^\d])(20\d{2})-(\d{2})-(\d{2})(?=$|[^\d])/u);
    if(iso)return make(Number(iso[3]),Number(iso[2]),Number(iso[1]),iso[0]);
    const named=text.match(new RegExp(`(?:^|[^\\d])(\\d{1,2})\\s*(${MONTHS.join('|')})(?=$|[^\\p{L}])(?:\\s+(20\\d{2}))?`,'iu'));
    if(named){const month=MONTHS.findIndex(values=>values.split('|').includes(named[2].toLowerCase()))+1;return make(Number(named[1]),month,named[3]?Number(named[3]):undefined,named[0]);}
    const numeric=text.match(/(?:^|[^\d])(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?(?=$|[^\d])/u);
    if(numeric){const year=numeric[3]?Number(numeric[3]):undefined;return make(Number(numeric[1]),Number(numeric[2]),year!==undefined&&year<100?2000+year:year,numeric[0]);}
    return null;
}
export function resolveBrowserTargetDate(text: string, now = new Date(), timeZone = BROWSER_TIME_ZONE): string | null {
    // Ambiguous exclusions/ranges stay with the planner, rather than silently choosing a day.
    if (/(?:^|[^\p{L}])(?:не|кроме|not|except)(?=$|[^\p{L}])/iu.test(text)) return null;
    const explicit=parseBrowserDate(text,now,timeZone);if(explicit)return explicit.localDate;
    const today=browserLocalDate(now,timeZone);
    if(/послезавтра|day after tomorrow/iu.test(text))return shiftBrowserDate(today,2);
    if(/завтра|tomorrow/iu.test(text))return shiftBrowserDate(today,1);
    if(/сегодня|today/iu.test(text))return today;
    const days=['воскресень\\p{L}*|sunday','понедельник\\p{L}*|monday','вторник\\p{L}*|tuesday','сред[ауыое]|wednesday','четверг\\p{L}*|thursday','пятниц\\p{L}*|friday','суббот\\p{L}*|saturday'];
    const matched=days.map((value,index)=>new RegExp(`(?:^|[^\\p{L}])(?:${value})(?=$|[^\\p{L}])`,'iu').test(text)?index:-1).filter(index=>index>=0);
    if(matched.length!==1)return null;
    const day=matched[0];
    const weekday=new Date(today+'T12:00:00Z').getUTCDay();let delta=(day-weekday+7)%7;
    if(delta===0 && /следующ|next/iu.test(text))delta=7;
    return shiftBrowserDate(today,delta);
}

export function resolveBrowserDateRange(text: string, now = new Date(), timeZone = BROWSER_TIME_ZONE): {label:string;startMs:number;endMs:number}|null {
    if(/недел|week/iu.test(text) && /следующ|next/iu.test(text) && /(?:^|[^\p{L}])(?:эт\p{L}*|this)(?=$|[^\p{L}])/iu.test(text))return null;
    const date=resolveBrowserTargetDate(text,now,timeZone);
    if(date)return {label:date,startMs:browserDateEpoch(date,timeZone),endMs:browserDateEpoch(shiftBrowserDate(date,1),timeZone)};
    if (/(?:^|[^\p{L}])(?:не|кроме|not|except)(?=$|[^\p{L}])/iu.test(text)) return null;
    const nextWeek=/следующ\p{L}*\s+недел|next\s+week/iu.test(text), thisWeek=/эт\p{L}*\s+недел|this\s+week/iu.test(text);
    if(nextWeek===thisWeek)return null;
    const today=browserLocalDate(now,timeZone),weekday=new Date(today+'T12:00:00Z').getUTCDay()||7;
    const start=shiftBrowserDate(today,1-weekday+(nextWeek?7:0));
    return {label:nextWeek?'следующая неделя':'эта неделя',startMs:browserDateEpoch(start,timeZone),endMs:browserDateEpoch(shiftBrowserDate(start,7),timeZone)};
}
