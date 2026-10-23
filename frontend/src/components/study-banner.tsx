/** Original vector poster: a book opens into a flowing ribbon of shared ideas. */
export function StudyBanner() {
  return (
    <svg
      className="entry-illustration"
      viewBox="0 0 1600 1000"
      preserveAspectRatio="xMidYMid slice"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id="poster-left-page">
          <path d="M299 845C239 791 161 767 96 756l52-213c80 19 140 81 151 164z" />
        </clipPath>
        <clipPath id="poster-right-page">
          <path d="M299 845c26-86 79-144 149-166l-35-218c-85 35-132 119-114 246z" />
        </clipPath>
      </defs>

      {/* A continuous line connects the book, the paper plane and the idea. */}
      <g className="poster-trail" stroke="var(--poster-line)" strokeWidth="1.5">
        <path d="M-70 544C104 356 166 458 176 625c13 225 132 341 358 277 204-58 288-90 468-29 176 59 399-5 409-183 5-96-61-182-136-205" />
        <path d="M1015 852c76-12 110-55 96-90-22-56-117 3-48 47 47 30 116 11 160-22" strokeDasharray="4 7" strokeLinecap="round" />
      </g>

      {/* Folded pages form a fan of distinct planes. */}
      <g className="poster-book">
        <g className="poster-book-motion">
        <path d="m80 774 219 104 158-152-199-80z" fill="var(--poster-blue-deep)" />
        <path d="m80 760 219 102 158-151-199-80z" fill="var(--poster-blue)" />
        <path className="poster-bookmark" d="M294 823h18l7 85-13-8-13 10Z" fill="var(--poster-coral)" />
        <path d="M299 845C239 791 161 767 96 756l52-213c80 19 140 81 151 164z" fill="var(--poster-paper)" stroke="var(--poster-blue-deep)" strokeWidth="2" />
        <g clipPath="url(#poster-left-page)" stroke="var(--poster-page-line)" strokeWidth="2" strokeLinecap="round">
          <path d="M142 590c43 14 78 39 108 72M138 609c44 14 80 39 111 72M133 628c44 14 82 39 114 72M129 647c45 14 83 39 116 72M124 666c46 14 85 39 119 72M120 685c46 14 87 39 121 72M115 704c47 14 88 39 123 72" />
        </g>
        <path d="M299 845c26-86 79-144 149-166l-35-218c-85 35-132 119-114 246z" fill="var(--poster-paper)" stroke="var(--poster-blue-deep)" strokeWidth="2" />
        <g clipPath="url(#poster-right-page)" stroke="var(--poster-page-line)" strokeWidth="2" strokeLinecap="round">
          <path d="M320 680c18-69 45-125 79-157M321 702c20-69 47-125 81-157M322 724c22-69 49-125 83-157M323 746c24-69 51-125 85-157M324 768c26-69 53-125 87-157M325 790c28-69 55-125 89-157" />
        </g>
        <path className="poster-page-left" d="M299 845c-26-94-79-149-149-176l49-211c74 35 109 123 100 249z" fill="#d8e7ff" stroke="var(--poster-blue-deep)" strokeWidth="2" />
        <path className="poster-page-right" d="M299 845c12-88 39-158 93-203l-44-219c-57 56-75 153-49 284z" fill="var(--poster-paper)" stroke="var(--poster-blue-deep)" strokeWidth="2" />
        <path d="M299 845c-9-88-30-159-74-207l25-205c45 47 67 142 49 274z" fill="var(--poster-paper)" stroke="var(--poster-blue-deep)" strokeWidth="2" />
        <path d="M299 845v-138c18-131 41-221 49-284-43 34-63 119-49 284" fill="#afcfff" stroke="var(--poster-blue-deep)" strokeWidth="2" />
        <path d="M299 845v18" stroke="var(--poster-blue-deep)" strokeWidth="3" />
        </g>
      </g>

      {/* An idea in bloom: off-axis petals around an open centre. */}
      <g className="poster-idea">
        <g className="poster-flower-motion">
          <path d="M1360 420c0 46-3 70-8 100s-5 30-5 44-2 34-2 53" stroke="var(--poster-leaf-line)" strokeWidth="3" strokeLinecap="round" />
          <path d="M1352 520c-31-43-77-45-98-24 19 37 70 48 98 24Z" fill="var(--poster-green)" />
          <path d="M1347 564c25-42 73-42 94-23-23 36-62 43-94 23Z" fill="var(--poster-green)" />
          <path d="M1352 520c-22-10-47-18-74-22m69 66c24-13 46-19 71-22" stroke="var(--poster-leaf-line)" strokeWidth="1.5" strokeLinecap="round" />
          <g transform="translate(1360 365) rotate(-12)">
            {Array.from({ length: 8 }, (_, i) => (
              <path
                key={i}
                transform={`rotate(${i * 45})`}
                d="M-22-26C-80-71-72-153-23-151 17-150 37-80 22-26Z"
                fill="var(--poster-coral)"
              />
            ))}
            <circle r="38" fill="var(--poster-yellow)" />
            <path d="m-10 0 7 7 15-17" stroke="var(--poster-on-yellow)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </g>
        </g>
      </g>

      <g className="poster-conversation" transform="translate(335 228) rotate(-14)">
        <path d="M-49-35h78a18 18 0 0 1 18 18v31a18 18 0 0 1-18 18H-8l-23 23V32h-18a18 18 0 0 1-18-18v-31a18 18 0 0 1 18-18Z" fill="var(--poster-yellow)" />
        <path d="M-35-9c9-8 15 8 24 0S4-1 13-9s15 8 24 0M-35 6c9-8 15 8 24 0S4 14 13 6s15 8 24 0" stroke="var(--poster-on-yellow)" strokeWidth="2.5" strokeLinecap="round" />
      </g>

      <g className="poster-plane" transform="translate(1245 770) rotate(-12)">
        <g className="poster-plane-motion">
          <path d="m-72-32 154-25-91 108-9-54Z" fill="var(--poster-blue)" />
          <path d="m-18-3 100-54L-9 51Z" fill="var(--poster-blue-deep)" />
          <path d="M-18-3 82-57 4 14Z" fill="#b8d3ff" />
        </g>
      </g>

      <g className="poster-marks" stroke="var(--poster-ink)" strokeWidth="2" strokeLinecap="round">
        <path d="m1120 173 1 28m-14-14h28m-24-10 20 20m-20 0 20-20" />
        <path d="m474 730 1 22m-12-11h22" />
        <path d="m147 346 12-13m-31-5 3-15m-20 28-15-3" />
        <circle cx="1190" cy="618" r="6" fill="var(--poster-green)" stroke="none" />
        <circle cx="454" cy="338" r="4" fill="var(--poster-blue)" stroke="none" />
      </g>
    </svg>
  );
}
