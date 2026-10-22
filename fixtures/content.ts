/** Fictional data for layout and contract validation. Never present as live Notion content. */
import type { ContentKind, ContentByKind, ContentDocument, CourseTree } from "../contracts/content.ts";
import { expandFixtures } from "./expand.ts";

export const fixtureItems: { [K in ContentKind]: ContentByKind[K][] } = {
  page: [{ id: "mock-about", kind: "page", pageKey: "about", slug: "about", href: "/about", title: "[演示] 关于这个角落", summary: null, tags: [], cover: null, updatedAt: "2026-10-01T00:00:00Z" }],
  project: [{ id: "mock-project-1", kind: "project", slug: "demo-project", href: "/projects/demo-project", title: "[演示] 小型学习工具", summary: "虚构项目，用于页面和契约联调。", tags: ["工具"], cover: null, updatedAt: null, period: { start: "2026-09-03", end: null, precision: "date" }, role: "个人项目", stack: ["TypeScript"], links: [{ label: "示例说明", url: "https://example.com/project" }] }],
  "post": [
    {
      "id": "mock-post-1",
      "kind": "post",
      "slug": "building-my-corner",
      "href": "/blog/building-my-corner",
      "title": "[演示] 一个自己的互联网角落",
      "summary": "用于文章页布局与正文组件联调的虚构示例。",
      "tags": [
        "网站",
        "随笔"
      ],
      "cover": null,
      "updatedAt": null,
      "publishedAt": {
        "start": "2026-10-10",
        "end": null,
        "precision": "date"
      }
    },
    {
      "id": "mock-post-2",
      "kind": "post",
      "slug": "long-title",
      "href": "/blog/long-title",
      "title": "[演示] 在忙碌的学习、生活与项目之间，如何慢慢整理一份可回顾的个人记录",
      "summary": null,
      "tags": [],
      "cover": null,
      "updatedAt": null,
      "publishedAt": null
    }
  ],
  "status": [
    {
      "id": "mock-status-1",
      "kind": "status",
      "slug": "a-small-progress",
      "href": "/status",
      "title": "[演示] 今天完成了一小步",
      "summary": null,
      "tags": [],
      "cover": null,
      "updatedAt": null,
      "recordedAt": {
        "start": "2026-10-10T08:00:00Z",
        "end": null,
        "precision": "datetime"
      },
      "text": [
        {
          "text": "给网站留出一点空间，慢慢记录学习和生活。"
        }
      ]
    },
    {
      "id": "mock-status-2",
      "kind": "status",
      "slug": "untitled",
      "href": "/status",
      "title": "[演示] 无标题动态的摘要回退",
      "summary": null,
      "tags": [],
      "cover": null,
      "updatedAt": null,
      "recordedAt": null,
      "text": [
        {
          "text": "这个样本用于验证原始标题为空时的展示。"
        }
      ]
    }
  ],
  "album": [
    {
      "id": "mock-album-1",
      "kind": "album",
      "slug": "a-walk",
      "href": "/photos/a-walk",
      "title": "[演示] 一次散步",
      "summary": null,
      "tags": [],
      "cover": {
        "id": "mock-album-cover",
        "src": "/mock-media/landscape.svg",
        "alt": "演示占位图",
        "width": 1200,
        "height": 800
      },
      "updatedAt": null,
      "date": {
        "start": "2026-10-09",
        "end": null,
        "precision": "date"
      },
      "photoCount": 2
    },
    {
      "id": "mock-album-2",
      "kind": "album",
      "slug": "empty-album",
      "href": "/photos/empty-album",
      "title": "[演示] 相册空内容状态",
      "summary": null,
      "tags": [],
      "cover": null,
      "updatedAt": null,
      "date": null,
      "photoCount": 0
    }
  ],
  "book": [
    {
      "id": "mock-book-1",
      "kind": "book",
      "slug": "reading-notes",
      "href": "/library/books/reading-notes",
      "title": "[演示] 一本读完但未记录日期的书",
      "summary": null,
      "tags": [],
      "cover": {
        "id": "mock-book-cover",
        "src": "/mock-media/book.svg",
        "alt": "演示占位图",
        "width": 600,
        "height": 900
      },
      "updatedAt": null,
      "authors": [
        "演示作者"
      ],
      "status": "read",
      "readingDate": null,
      "pagesRead": 260,
      "totalPages": 260,
      "progressPercent": 100,
      "personalRating": null,
      "doubanRating": 8.1,
      "externalUrl": null
    },
    {
      "id": "mock-book-2",
      "kind": "book",
      "slug": "currently-reading",
      "href": "/library/books/currently-reading",
      "title": "[演示] 正在阅读",
      "summary": null,
      "tags": [],
      "cover": {
        "id": "mock-book-cover",
        "src": "/mock-media/book.svg",
        "alt": "演示占位图",
        "width": 600,
        "height": 900
      },
      "updatedAt": null,
      "authors": [
        "演示作者"
      ],
      "status": "reading",
      "readingDate": {
        "start": "2026-10-01",
        "end": null,
        "precision": "date"
      },
      "pagesRead": 10,
      "totalPages": 250,
      "progressPercent": 4,
      "personalRating": null,
      "doubanRating": null,
      "externalUrl": null
    },
    {
      "id": "mock-book-3",
      "kind": "book",
      "slug": "wishlist-book",
      "href": "/library/books/wishlist-book",
      "title": "[演示] 想读书目",
      "summary": null,
      "tags": [],
      "cover": null,
      "updatedAt": null,
      "authors": [],
      "status": "wishlist",
      "readingDate": null,
      "pagesRead": null,
      "totalPages": null,
      "progressPercent": null,
      "personalRating": null,
      "doubanRating": null,
      "externalUrl": null
    }
  ],
  "movie": [
    {
      "id": "mock-movie-1",
      "kind": "movie",
      "slug": "a-film",
      "href": "/library/movies/a-film",
      "title": "[演示] 一部没有观影日期的电影",
      "summary": null,
      "tags": [],
      "cover": null,
      "updatedAt": null,
      "originalTitle": "Demo Film",
      "mediaType": "电影",
      "status": "watched",
      "watchedDate": null,
      "releaseDate": {
        "start": "2025-01-01",
        "end": null,
        "precision": "date"
      },
      "director": "演示导演",
      "actors": [
        "演示演员"
      ],
      "rating": {
        "value": 4,
        "scale": 5,
        "label": "★★★★"
      },
      "doubanRating": 7.8
    },
    {
      "id": "mock-movie-2",
      "kind": "movie",
      "slug": "wishlist-series",
      "href": "/library/movies/wishlist-series",
      "title": "[演示] 想看的剧集",
      "summary": null,
      "tags": [],
      "cover": null,
      "updatedAt": null,
      "originalTitle": null,
      "mediaType": "剧集",
      "status": "wishlist",
      "watchedDate": null,
      "releaseDate": null,
      "director": null,
      "actors": [],
      "rating": null,
      "doubanRating": null
    },
    {
      "id": "mock-movie-3",
      "kind": "movie",
      "slug": "unknown-status",
      "href": "/library/movies/unknown-status",
      "title": "[演示] 未分类影视",
      "summary": null,
      "tags": [],
      "cover": null,
      "updatedAt": null,
      "originalTitle": null,
      "mediaType": null,
      "status": "unknown",
      "watchedDate": null,
      "releaseDate": null,
      "director": null,
      "actors": [],
      "rating": null,
      "doubanRating": null
    }
  ],
  "game": [
    {
      "id": "mock-game-1",
      "kind": "game",
      "slug": "game-clear",
      "href": "/library/games/game-clear",
      "title": "[演示] 已通关的游戏",
      "summary": null,
      "tags": [],
      "cover": {
        "id": "mock-game-cover",
        "src": "/mock-media/game.svg",
        "alt": "演示占位图",
        "width": 900,
        "height": 900
      },
      "updatedAt": null,
      "status": "clear",
      "platforms": [
        "PlayStation"
      ],
      "lastPlayedDate": null,
      "firstPlayedDate": null,
      "playedDate": {
        "start": "2026-09-01",
        "end": null,
        "precision": "date"
      },
      "releaseDate": null,
      "playedTime": {
        "value": 45,
        "unit": "hour"
      },
      "estimatedTime": {
        "value": 60,
        "unit": "hour"
      },
      "progressPercent": 75,
      "rating": {
        "value": 4,
        "scale": 5,
        "label": "★★★★"
      }
    },
    {
      "id": "mock-game-2",
      "kind": "game",
      "slug": "game-platinumed",
      "href": "/library/games/game-platinumed",
      "title": "[演示] 已白金的游戏",
      "summary": null,
      "tags": [],
      "cover": {
        "id": "mock-game-cover",
        "src": "/mock-media/game.svg",
        "alt": "演示占位图",
        "width": 900,
        "height": 900
      },
      "updatedAt": null,
      "status": "platinumed",
      "platforms": [
        "PlayStation"
      ],
      "lastPlayedDate": null,
      "firstPlayedDate": null,
      "playedDate": {
        "start": "2026-09-01",
        "end": null,
        "precision": "date"
      },
      "releaseDate": null,
      "playedTime": {
        "value": 45,
        "unit": "hour"
      },
      "estimatedTime": {
        "value": 60,
        "unit": "hour"
      },
      "progressPercent": 75,
      "rating": {
        "value": 4,
        "scale": 5,
        "label": "★★★★"
      }
    },
    {
      "id": "mock-game-3",
      "kind": "game",
      "slug": "game-playing",
      "href": "/library/games/game-playing",
      "title": "[演示] 正在玩的游戏",
      "summary": null,
      "tags": [],
      "cover": {
        "id": "mock-game-cover",
        "src": "/mock-media/game.svg",
        "alt": "演示占位图",
        "width": 900,
        "height": 900
      },
      "updatedAt": null,
      "status": "playing",
      "platforms": [
        "Personal Computer"
      ],
      "lastPlayedDate": {
        "start": "2025-06-15",
        "end": null,
        "precision": "date"
      },
      "firstPlayedDate": {
        "start": "2025-01-02",
        "end": null,
        "precision": "date"
      },
      "playedDate": null,
      "releaseDate": null,
      "playedTime": {
        "value": 12,
        "unit": "hour"
      },
      "estimatedTime": {
        "value": 60,
        "unit": "hour"
      },
      "progressPercent": 20,
      "rating": null
    },
    {
      "id": "mock-game-4",
      "kind": "game",
      "slug": "game-wishlist",
      "href": "/library/games/game-wishlist",
      "title": "[演示] 想玩的游戏",
      "summary": null,
      "tags": [],
      "cover": null,
      "updatedAt": null,
      "status": "wishlist",
      "platforms": [
        "PlayStation"
      ],
      "lastPlayedDate": null,
      "firstPlayedDate": null,
      "playedDate": null,
      "releaseDate": null,
      "playedTime": null,
      "estimatedTime": null,
      "progressPercent": null,
      "rating": null
    }
  ],
  "course": [
    {
      "id": "mock-course-demo101",
      "kind": "course",
      "slug": "demo101",
      "href": "/study/demo101",
      "title": "[演示] DEMO101 Learning and collaboration",
      "summary": null,
      "tags": [],
      "cover": null,
      "updatedAt": null,
      "code": "DEMO101",
      "semester": "26S2",
      "ratings": {
        "experience": null,
        "usefulness": null,
        "recommendation": null,
        "difficulty": null
      }
    },
    {
      "id": "mock-course-demo102",
      "kind": "course",
      "slug": "demo102",
      "href": "/study/demo102",
      "title": "[演示] DEMO102 Programming foundations",
      "summary": null,
      "tags": [],
      "cover": null,
      "updatedAt": null,
      "code": "DEMO102",
      "semester": "25S1",
      "ratings": {
        "experience": {
          "value": 3,
          "scale": 5,
          "label": "★★★"
        },
        "usefulness": {
          "value": 5,
          "scale": 5,
          "label": "★★★★★"
        },
        "recommendation": {
          "value": 4,
          "scale": 5,
          "label": "★★★★"
        },
        "difficulty": {
          "value": 4,
          "scale": 5,
          "label": "★★★★"
        }
      }
    }
  ],
  "study-note": [
    {
      "id": "mock-note-week4",
      "kind": "study-note",
      "slug": "week-4",
      "href": "/study/demo101/notes/week-4",
      "title": "[演示] Week 4：跨文化协作",
      "summary": null,
      "tags": [],
      "cover": null,
      "updatedAt": null,
      "courseId": "mock-course-demo101",
      "parentId": null,
      "noteType": "course",
      "date": {
        "start": "2026-08-17",
        "end": null,
        "precision": "date"
      },
      "breadcrumbs": [
        {
          "title": "学习",
          "href": "/study"
        },
        {
          "title": "DEMO101",
          "href": "/study/demo101"
        }
      ]
    },
    {
      "id": "mock-note-knowledge",
      "kind": "study-note",
      "slug": "communication-context",
      "href": "/study/demo101/notes/communication-context",
      "title": "[演示] 一个知识子页面",
      "summary": null,
      "tags": [],
      "cover": null,
      "updatedAt": null,
      "courseId": "mock-course-demo101",
      "parentId": "mock-note-week4",
      "noteType": "note",
      "date": null,
      "breadcrumbs": [
        {
          "title": "学习",
          "href": "/study"
        },
        {
          "title": "DEMO101",
          "href": "/study/demo101"
        },
        {
          "title": "Week 4",
          "href": "/study/demo101/notes/week-4"
        }
      ]
    },
    {
      "id": "mock-note-workshop",
      "kind": "study-note",
      "slug": "workshop",
      "href": "/study/demo102/notes/workshop",
      "title": "[演示] Workshop",
      "summary": null,
      "tags": [],
      "cover": null,
      "updatedAt": null,
      "courseId": "mock-course-demo102",
      "parentId": null,
      "noteType": "course",
      "date": null,
      "breadcrumbs": [
        {
          "title": "学习",
          "href": "/study"
        },
        {
          "title": "DEMO102",
          "href": "/study/demo102"
        }
      ]
    }
  ]
};
export const fixtureDocuments: Record<string, ContentDocument> = {
  "mock-post-1": {
    "blocks": [
      {
        "id": "mock-b-toc",
        "type": "table-of-contents"
      },
      {
        "id": "mock-b-heading",
        "type": "heading",
        "level": 2,
        "text": [
          {
            "text": "正文组件演示"
          }
        ]
      },
      {
        "id": "mock-b-p",
        "type": "paragraph",
        "text": [
          {
            "text": "这是虚构的联调正文，不是已迁移的真实文章。"
          }
        ]
      },
      {
        "id": "mock-b-list",
        "type": "list",
        "ordered": false,
        "items": [
          {
            "id": "mock-li-1",
            "text": [
              {
                "text": "支持列表和子列表"
              }
            ],
            "checked": null,
            "children": [
              {
                "id": "mock-li-child",
                "type": "paragraph",
                "text": [
                  {
                    "text": "嵌套的说明文字。"
                  }
                ]
              }
            ]
          },
          {
            "id": "mock-li-2",
            "text": [
              {
                "text": "完成状态的样式"
              }
            ],
            "checked": true,
            "children": []
          }
        ]
      },
      {
        "id": "mock-b-quote",
        "type": "quote",
        "text": [
          {
            "text": "用内容验证设计。"
          }
        ]
      },
      {
        "id": "mock-b-callout",
        "type": "callout",
        "tone": "info",
        "icon": "📝",
        "text": [
          {
            "text": "提示信息"
          }
        ],
        "children": [
          {
            "id": "mock-callout-child",
            "type": "paragraph",
            "text": [
              {
                "text": "可以包含更长的解释。"
              }
            ]
          }
        ]
      },
      {
        "id": "mock-b-toggle",
        "type": "toggle",
        "title": [
          {
            "text": "展开查看学习笔记"
          }
        ],
        "children": [
          {
            "id": "mock-toggle-child",
            "type": "paragraph",
            "text": [
              {
                "text": "折叠区域支持键盘操作。"
              }
            ]
          }
        ]
      },
      {
        "id": "mock-b-code",
        "type": "code",
        "language": "typescript",
        "code": "const message = \"Hello, reader\";\nconsole.log(message);",
        "caption": [
          {
            "text": "演示代码"
          }
        ]
      },
      {
        "id": "mock-b-image",
        "type": "image",
        "image": {
          "id": "mock-photo-1",
          "src": "/mock-media/landscape.svg",
          "alt": "演示占位图",
          "width": 1200,
          "height": 800
        },
        "caption": [
          {
            "text": "图片说明需要在窄屏上保持可读。"
          }
        ]
      },
      {
        "id": "mock-b-divider",
        "type": "divider"
      },
      {
        "id": "mock-b-table",
        "type": "table",
        "hasColumnHeader": true,
        "hasRowHeader": false,
        "rows": [
          [
            [
              {
                "text": "场景"
              }
            ],
            [
              {
                "text": "展示方式"
              }
            ]
          ],
          [
            [
              {
                "text": "没有日期"
              }
            ],
            [
              {
                "text": "日期未记录"
              }
            ]
          ]
        ]
      },
      {
        "id": "mock-b-columns",
        "type": "columns",
        "columns": [
          {
            "ratio": 50,
            "blocks": [
              {
                "id": "mock-col-1",
                "type": "paragraph",
                "text": [
                  {
                    "text": "左栏"
                  }
                ]
              }
            ]
          },
          {
            "ratio": 50,
            "blocks": [
              {
                "id": "mock-col-2",
                "type": "paragraph",
                "text": [
                  {
                    "text": "右栏"
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        "id": "mock-b-bookmark",
        "type": "bookmark",
        "title": "Notion 数据源查询文档",
        "url": "https://developers.notion.com/reference/query-a-data-source",
        "description": "一个已解析的外部书签。"
      },
      {
        "id": "mock-b-embed",
        "type": "embed",
        "url": "https://developers.notion.com",
        "title": "演示外部资源",
        "display": "link"
      },
      {
        "id": "mock-b-child",
        "type": "child-page",
        "title": "一个知识子页面",
        "target": {
          "title": "一个知识子页面",
          "href": "/study/demo101/notes/communication-context"
        }
      },
      {
        "id": "mock-b-unavailable",
        "type": "child-page",
        "title": "未对外开放的子页面",
        "target": null
      },
      {
        "id": "mock-b-equation",
        "type": "equation",
        "expression": "a^2 + b^2 = c^2"
      },
      {
        "id": "mock-b-unsupported",
        "type": "unsupported",
        "label": "未能展开的内容"
      }
    ],
    "toc": [
      {
        "id": "mock-b-heading",
        "title": "正文组件演示",
        "level": 2
      }
    ],
    "completeness": "partial"
  },
  "mock-post-2": {
    "blocks": [],
    "toc": [],
    "completeness": "complete"
  },
  "mock-album-1": {
    "blocks": [
      {
        "id": "mock-b-image",
        "type": "image",
        "image": {
          "id": "mock-photo-1",
          "src": "/mock-media/landscape.svg",
          "alt": "演示占位图",
          "width": 1200,
          "height": 800
        },
        "caption": [
          {
            "text": "图片说明需要在窄屏上保持可读。"
          }
        ]
      },
      {
        "id": "mock-album-photo2",
        "type": "image",
        "image": {
          "id": "mock-photo-2",
          "src": "/mock-media/landscape.svg",
          "alt": "演示占位图",
          "width": 1200,
          "height": 800
        },
        "caption": []
      }
    ],
    "toc": [],
    "completeness": "complete"
  },
  "mock-album-2": {
    "blocks": [],
    "toc": [],
    "completeness": "complete"
  },
  "mock-book-1": {
    "blocks": [
      {
        "id": "mock-book-p",
        "type": "paragraph",
        "text": [
          {
            "text": "一段虚构的个人读书感想。"
          }
        ]
      }
    ],
    "toc": [],
    "completeness": "complete"
  },
  "mock-movie-1": {
    "blocks": [],
    "toc": [],
    "completeness": "complete"
  },
  "mock-game-1": {
    "blocks": [
      {
        "id": "mock-game-bookmark",
        "type": "unsupported",
        "label": "待解析书签"
      }
    ],
    "toc": [],
    "completeness": "partial"
  },
  "mock-note-week4": {
    "blocks": [
      {
        "id": "mock-week-heading",
        "type": "heading",
        "level": 2,
        "text": [
          {
            "text": "Own-time"
          }
        ]
      },
      {
        "id": "mock-week-intro",
        "type": "paragraph",
        "text": [
          {
            "text": "演示周次页，不包含教学资料全文。"
          }
        ]
      },
      {
        "id": "mock-week-child",
        "type": "child-page",
        "title": "一个知识子页面",
        "target": {
          "title": "一个知识子页面",
          "href": "/study/demo101/notes/communication-context"
        }
      }
    ],
    "toc": [
      {
        "id": "mock-week-heading",
        "title": "Own-time",
        "level": 2
      }
    ],
    "completeness": "complete"
  },
  "mock-note-knowledge": {
    "blocks": [
      {
        "id": "mock-knowledge-p",
        "type": "paragraph",
        "text": [
          {
            "text": "演示四层导航和关联笔记。"
          }
        ]
      }
    ],
    "toc": [],
    "completeness": "complete"
  },
  "mock-note-workshop": {
    "blocks": [
      {
        "id": "mock-java-code",
        "type": "code",
        "language": "java",
        "code": "System.out.println(\"Demo\");",
        "caption": []
      }
    ],
    "toc": [],
    "completeness": "complete"
  }
};
export const fixtureTrees: Record<string, CourseTree> = {
  "mock-course-demo101": {
    "courseId": "mock-course-demo101",
    "nodes": [
      {
        "id": "mock-note-week4",
        "title": "Week 4",
        "href": "/study/demo101/notes/week-4",
        "hasChildren": true,
        "children": [
          {
            "id": "mock-note-knowledge",
            "title": "知识子页面",
            "href": "/study/demo101/notes/communication-context",
            "hasChildren": false,
            "children": []
          }
        ]
      }
    ]
  },
  "mock-course-demo102": {
    "courseId": "mock-course-demo102",
    "nodes": [
      {
        "id": "mock-note-workshop",
        "title": "Workshop",
        "href": "/study/demo102/notes/workshop",
        "hasChildren": false,
        "children": []
      }
    ]
  }
};

expandFixtures(fixtureItems, fixtureDocuments, fixtureTrees);
